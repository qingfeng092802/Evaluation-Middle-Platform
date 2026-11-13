'use client';

/**
 * 页面侧的 SSE 订阅（Batch 3 · 交付物 4/5）。
 *
 * 计数语义全部在 `lib/ui/run-stream-client.ts`（纯函数，可单测）；本文件只管
 * **连接生命周期**，尤其是 `technical-solution.md` §3.5 [6] 那三步：
 *
 * ```
 * 断开旧连接 → GET /api/runs/:id 拉全量快照 → 重新订阅，丢弃 snapshot 之前的陈旧事件
 * ```
 *
 * ## 为什么不用浏览器 `EventSource` 的自动重连
 *
 * `EventSource` 断线后会在**不通知页面**的情况下自己重连 —— 它不知道
 * `snapshot_only` 策略，重连后从快照的位置继续收事件，页面上那段空窗就这么被
 * 抹平了。用户看到的是一条连续的进度线，实际中间漏了事件。
 * 「禁止制造『事件已补齐』的假象」在实现上就是：**关掉自动重连，自己走三步**。
 * 所以这里在 `onerror` 里 `close()` 并自己 `setTimeout` 重连。
 *
 * ## 为什么两条计时器都要
 *
 * `SSE_CLIENT_SILENCE_TIMEOUT_MS`（30s）判死连接；但死连接**不一定触发** `onerror`
 * （半开连接：TCP 还在，对端已经不发了）。心跳只有 15s 一条，30s 没动静就主动重连，
 * 比等浏览器超时（可能是几分钟）快得多。
 */
import * as React from 'react';
import {
  EvalProgressFrame,
  SSE_CLIENT_SILENCE_TIMEOUT_MS,
  isTerminalRunStatus,
} from '@eval-platform/contracts';
import {
  INITIAL_STREAM_PROGRESS,
  applyFrame,
  milestoneOf,
  shouldAnnounce,
  type StreamConnection,
  type StreamProgress,
} from './run-stream-client';

/** 重连退避上限：1s 起，翻倍，最多 8s。 */
const RECONNECT_MAX_MS = 8_000;

export interface UseRunStreamResult {
  readonly progress: StreamProgress;
  readonly connection: StreamConnection;
  /** 需要播报给读屏的文案；`null` ⇒ 不播报（避免每条 Case 都读一遍）。 */
  readonly announcement: string | null;
}

export interface UseRunStreamOptions {
  /** 进入终态时调用（页面据此刷新一次运行详情与明细，然后停下）。 */
  readonly onTerminal: () => void;
  /** §3.5 [6] 步骤 2：重连前拉全量快照。页面传 `run.reload`（走 `GET /api/runs/:id`）。 */
  readonly onResync: () => void;
}

/**
 * 订阅 `/api/runs/{runId}/stream`。
 *
 * `enabled=false`（终态、或 run 还没取到）时完全不建连接：终态之后流会自己关，
 * 再订阅一次只会拿到一个立刻结束的 200，然后被当成断线重连 —— 无限循环。
 */
export function useRunStream(
  runId: string,
  enabled: boolean,
  opts: UseRunStreamOptions,
): UseRunStreamResult {
  const [progress, setProgress] = React.useState<StreamProgress>(INITIAL_STREAM_PROGRESS);
  const [connection, setConnection] = React.useState<StreamConnection>('disconnected');
  const [announcement, setAnnouncement] = React.useState<string | null>(null);

  // 回调用 ref 持有：否则父组件每次 render 换一个函数引用都会重建 EventSource，
  // 表现为「进度条每秒闪一下重连」。
  const terminalRef = React.useRef(opts.onTerminal);
  const resyncRef = React.useRef(opts.onResync);
  React.useEffect(() => {
    terminalRef.current = opts.onTerminal;
    resyncRef.current = opts.onResync;
  }, [opts.onTerminal, opts.onResync]);

  React.useEffect(() => {
    if (runId === '' || !enabled) {
      setConnection('disconnected');
      return;
    }

    let disposed = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let silenceTimer: number | null = null;
    let attempt = 0;

    const clearSilence = (): void => {
      if (silenceTimer !== null) {
        window.clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    };

    /**
     * 重连编排（§3.5 [6]）：拉快照 → 再订阅。
     *
     * `retry` 用 `let` 先占位、`connect` 用 `function` 声明：这两者互相引用
     * （`armSilence` 与 `onerror` 要 `retry`，`retry` 的定时器要 `connect`，
     * `connect` 出错又要 `retry`）。函数声明会提升，`let` 在赋值前不会被调用到，
     * 循环引用就这样断开了。
     */
    let retry: () => void = () => undefined;

    /** 静默超时 ⇒ 视为死连接，主动断开走重连（半开连接不会自己报错）。 */
    const armSilence = (): void => {
      clearSilence();
      silenceTimer = window.setTimeout(() => {
        if (disposed) return;
        source?.close();
        source = null;
        retry();
      }, SSE_CLIENT_SILENCE_TIMEOUT_MS);
    };

    const retryImpl = (): void => {
      if (disposed) return;
      clearSilence();
      // 已持有连接、或已有一次重连在排队，就不要叠加第二个：
      // `onerror` 与静默超时可以同时触发（先超时关连接，关闭又会派发一次 error）。
      // 两条连接并存时，同一条 Case 会被两个 EventSource 各收一次。
      if (source !== null || reconnectTimer !== null) return;
      setConnection('reconnecting');
      const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        // §3.5 [6] 步骤 2：**先拉全量快照**（快照即真相），再重新订阅。
        // 顺序不能反：先订阅再拉快照，会在一片旧数据上先画出新计数。
        // 也不做事件回放 —— `snapshot_only` 明令禁止，回放配合前端状态
        // 就会变成双倍计数。
        try {
          resyncRef.current();
        } finally {
          if (!disposed) connect();
        }
      }, delay);
    };
    retry = retryImpl;

    const connect = (): void => {
      if (disposed) return;
      if (source !== null) return; // 已有活连接：绝不叠加第二条
      const es = new EventSource(`/api/runs/${runId}/stream`);
      source = es;

      const handle = (raw: MessageEvent<string>): void => {
        if (disposed) return;
        armSilence();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.data);
        } catch {
          return; // 坏帧直接丢：一条解析不了的 JSON 不能把整条流打死
        }
        const frame = EvalProgressFrame.safeParse({
          id: raw.lastEventId === '' ? undefined : raw.lastEventId,
          event: raw.type,
          data: parsed,
        });
        if (!frame.success) return;

        attempt = 0; // 收到有效帧即视为连通，退避归零
        setConnection('connected');
        setProgress((prev) => {
          const next = applyFrame(prev, frame.data);
          return next;
        });

        const data = frame.data.data;
        if (data.type === 'status' && isTerminalRunStatus(data.to)) {
          // 终态是最后一个业务事件，服务端随即便关流。主动关掉，
          // 否则 `EventSource` 会把它当断线再重连一次。
          es.close();
          source = null;
          clearSilence();
          terminalRef.current();
        }
      };

      for (const name of ['snapshot', 'case', 'status', 'heartbeat', 'error'] as const) {
        es.addEventListener(name, handle as EventListener);
      }

      es.onerror = () => {
        // 不交给 `EventSource` 自动重连：它不知道 `snapshot_only`。
        es.close();
        if (source === es) source = null;
        retry();
      };

      // 首个连接：从「重连中」起步，收到 snapshot 才算「已连接」。
      setConnection((c) => (c === 'connected' ? c : 'reconnecting'));
      armSilence();
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      clearSilence();
      source?.close();
      source = null;
    };
    // `onTerminal` 走 ref，不进 deps：它变引用不该重建连接。
  }, [runId, enabled]);

  // ---- 播报：只播连接变化与 10% 里程碑 ----
  const milestone = milestoneOf(progress.completedCount, progress.totalCount);
  const lastAnnouncedRef = React.useRef<{ connection: StreamConnection; milestone: number } | null>(
    null,
  );

  React.useEffect(() => {
    const prev = lastAnnouncedRef.current;
    const next = { connection, milestone };
    if (prev !== null && !shouldAnnounce(prev, next)) return;
    lastAnnouncedRef.current = next;
    // 首次挂载不播报（连接还没建立，播一句「已断开」只会制造噪音）
    if (prev === null) return;
    setAnnouncement(announcementText(prev, next));
  }, [connection, milestone]);

  return { progress, connection, announcement };
}

function announcementText(
  prev: { connection: StreamConnection; milestone: number },
  next: { connection: StreamConnection; milestone: number },
): string {
  const conn =
    next.connection === 'connected'
      ? '已连接'
      : next.connection === 'reconnecting'
        ? '连接中断，正在重连'
        : '已断开';
  if (prev.connection !== next.connection) return conn;
  return `进度 ${String(next.milestone)}%`;
}
