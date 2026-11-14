/**
 * `GET /api/runs/{runId}/stream` 的事件源（Batch 3 · 交付物 2/3/5）。
 *
 * ## 三条不能违反的规则，以及违反了会怎样
 *
 * 1. **首帧恒为 `snapshot`。** `PROGRESS_RESUME_POLICY.mode = 'snapshot_only'`：
 *    重连第一步是拉全量快照，**不做事件回放**。回放需要环形缓冲，进程重启即空，
 *    并不能替代快照 —— 那只是让正确性依赖一个不可靠的优化。
 *    *违反后果*：断线重连后进度条停在断线前的位置，直到下一条 `case` 事件才跳。
 *
 * 2. **`LISTEN` 必须用独立连接，不能借连接池。** 连接池会把同一条连接借给
 *    不同的请求，`LISTEN` 的状态跟着连接走 —— 借出去再还回来，通知就投给了别人。
 *    *违反后果*：本机大概率不重现（池里恰好空闲），上线后「进度条偶尔不动」。
 *
 * 3. **计数只从库里读，不累加事件。** `case` 事件里的 `completedCount` 是
 *    **回查数据库**得到的，不是「上一个值 +1」。
 *    *违反后果*：重连一次多计一遍，进度条能冲到 110%，而且只有断线的人看得到。
 *
 * 另外：`NOTIFY` 不保证投递（连接抖动、事务回滚前发出）。所以这里还把
 * 「15s 心跳」当成一次**免费的自愈点** —— 心跳时顺手回查一次计数，
 * 丢了通知也能在 15s 内追上。心跳因此不只是保活，它是丢事件后的兜底。
 */
import { Client } from 'pg';
import {
  encodeStreamEventId,
  SSE_HEARTBEAT_INTERVAL_MS,
  type CaseResultStatus,
  type EvalRunCounts,
  type EvalRunMetrics,
  type RunStatus,
  type SseEventName,
} from '@eval-platform/contracts';
import { getPool } from '../../../db/schema/index.js';
import { getRunDetail } from '../../../db/repo/evalRuns.js';
import { databaseUrl } from '../../../db/migrate.js';

/** 与 `contracts/src/sse.ts` 的 `EvalProgressFrame` 同形（这里不 import zod 校验，见下）。 */
export interface StreamFrame {
  readonly id: string;
  readonly event: SseEventName;
  readonly data:
    | {
        type: 'snapshot';
        runId: string;
        status: RunStatus;
        counts: EvalRunCounts;
        metrics: EvalRunMetrics;
        startedAt: string | null;
        finishedAt: string | null;
      }
    | {
        type: 'case';
        runId: string;
        caseKey: string;
        completedCount: number;
        totalCount: number;
        score: number | null;
        passed: boolean | null;
        status: 'OK' | 'FAILED' | 'TIMEOUT' | 'QUOTA_EXCEEDED' | 'PARSE_ERROR' | 'SKIPPED';
        latencyMs: number | null;
      }
    | { type: 'status'; runId: string; from: RunStatus; to: RunStatus; at: string }
    | { type: 'heartbeat'; at: string }
    | { type: 'error'; runId: string; code: string; message: string; caseKey?: string };
}

export interface RunStreamOptions {
  readonly runId: string;
  /** 浏览器 `Last-Event-ID`。**只用于日志/去重标记，不触发回放。** */
  readonly lastEventId?: string | undefined;
  /** 心跳间隔；测试可调小。 */
  readonly heartbeatMs?: number | undefined;
}

const TERMINAL: readonly RunStatus[] = ['COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'];

/** 从回查结果里取「这一帧的完成计数」—— 唯一口径。 */
function completedOf(counts: EvalRunCounts): number {
  return counts.succeededCases + counts.failedCases + counts.skippedCases;
}

/**
 * 造一个异步事件生成器。
 *
 * 调用方负责 `for await` 或 `return()`；本函数在所有退出路径上关掉自己的
 * `LISTEN` 连接（`finally`），否则每个断开的浏览器标签页都会漏一条 PG 连接。
 */
export async function* runEventStream(opts: RunStreamOptions): AsyncGenerator<StreamFrame> {
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;

  // ---- 先 LISTEN，再取快照 ----
  //
  // 顺序反过来的话，两条命令之间存在一个窗口：快照已读、`LISTEN` 未生效，
  // 这期间 worker 的 `NOTIFY` 会**彻底消失**（PG 不排队等订阅者）。
  // 症状是「连上之后进度卡住，直到下一次心跳才追上」—— 而心跳是 15s。
  // 先订阅后读快照，最坏情况只是多读一次已经包含在快照里的通知（幂等）。
  const listener = new Client({ connectionString: databaseUrl() });
  await listener.connect();
  /** 唤醒信号：通知到了 / 心跳到点。 */
  let wake: (() => void) | null = null;
  let pendingNotify = false;
  let closed = false;

  listener.on('notification', () => {
    pendingNotify = true;
    wake?.();
  });

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await listener.end().catch(() => undefined);
  };

  try {
    await listener.query('LISTEN run_progress');

    // ---- 首帧：snapshot（快照即真相）----
    const detail = await getRunDetail(opts.runId);
    if (!detail) {
      yield {
        id: encodeStreamEventId(opts.runId, 0),
        event: 'error',
        data: { type: 'error', runId: opts.runId, code: 'NOT_FOUND', message: '评测运行不存在' },
      };
      return;
    }

    let seq = 0;
    let lastCounts = detail.counts;
    let lastStatus: RunStatus = detail.status;

    yield {
      id: encodeStreamEventId(opts.runId, seq),
      event: 'snapshot',
      data: {
        type: 'snapshot',
        runId: detail.id,
        status: detail.status,
        counts: detail.counts,
        metrics: detail.metrics,
        startedAt: detail.startedAt,
        finishedAt: detail.finishedAt,
      },
    };
    seq += 1;

    // 已经是终态：不需要订阅，snapshot 之后直接结束（客户端据此转静态）
    if (TERMINAL.includes(detail.status)) return;

    const timer = setInterval(() => wake?.(), heartbeatMs);
    let lastHeartbeatAt = Date.now();

    try {
      for (;;) {
        // 等「有事发生」：NOTIFY 或心跳，谁先到都行
        await new Promise<void>((resolve) => {
          wake = resolve;
          // 通知可能在进入循环前就到了，这里补一次检查，避免丢
          if (pendingNotify) resolve();
        });
        wake = null;
        // **先清标记再读库**：读之前发生的通知都已被本次读取覆盖，
        // 读的过程中来的通知会重新置 true，下一轮立刻再读一次。
        // 反过来（读完再清）会把「读期间的写入」一起清掉，表现为偶尔少一帧。
        pendingNotify = false;

        const fresh = await getRunDetail(opts.runId);
        if (!fresh) {
          yield {
            id: encodeStreamEventId(opts.runId, seq),
            event: 'error',
            data: { type: 'error', runId: opts.runId, code: 'NOT_FOUND', message: '运行已被删除' },
          };
          return;
        }

      // ---- 状态变更 ⇒ status 事件（终态是最后一个业务事件）----
      if (fresh.status !== lastStatus) {
        yield {
          id: encodeStreamEventId(opts.runId, seq),
          event: 'status',
          data: {
            type: 'status',
            runId: fresh.id,
            from: lastStatus,
            to: fresh.status,
            at: new Date().toISOString(),
          },
        };
        seq += 1;
        lastStatus = fresh.status;
      }

      // ---- 计数增长 ⇒ 逐个 case 事件（计数回查，不累加）----
      const completed = completedOf(fresh.counts);
      const before = completedOf(lastCounts);
      if (completed > before) {
        // 一次 NOTIFY 可能覆盖多条（并发写库），用明细补齐这中间的差额。
        // 仍然只拿「库里的行」当事实，不把差额平摊成假事件。
        const rows = await loadNewCaseRows(opts.runId, before, completed - before);
        for (const row of rows) {
          yield {
            id: encodeStreamEventId(opts.runId, seq),
            event: 'case',
            data: {
              type: 'case',
              runId: fresh.id,
              caseKey: row.caseKey,
              completedCount: row.completedCount,
              totalCount: fresh.counts.totalCases,
              score: row.score,
              passed: row.passed,
              status: row.status,
              latencyMs: row.latencyMs,
            },
          };
          seq += 1;
        }
      }
      lastCounts = fresh.counts;

      if (TERMINAL.includes(fresh.status)) return;

      // ---- 心跳：不只是保活，也是丢通知后的自愈点 ----
      if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
        lastHeartbeatAt = Date.now();
        yield {
          id: encodeStreamEventId(opts.runId, seq),
          event: 'heartbeat',
          data: { type: 'heartbeat', at: new Date().toISOString() },
        };
        seq += 1;
      }
      }
    } finally {
      clearInterval(timer);
      // `UNLISTEN` 不是必须的，但显式关连接能让池/连接数立即可见地回落
      await listener.end().catch(() => undefined);
    }
  } finally {
    // 外层 finally 覆盖「还没进入订阅循环就退出」的路径（例如刚 yield 完
    // snapshot 调用方就断开）：否则每个断开的标签页会漏一条 PG 连接。
    await shutdown();
  }
}

interface CaseRow {
  caseKey: string;
  completedCount: number;
  score: number | null;
  passed: boolean | null;
  status: CaseResultStatus;
  latencyMs: number | null;
}

/**
 * 取「从第 skip 条起、最多 limit 条」已完成 Case 的投影。
 *
 * 为什么不是「一次 NOTIFY 一条」：并发 8 的情况下，两条通知之间可能已经
 * 落了 5 行结果。若每次只发最后一条，客户端的「已完成 N」就会跳号，
 * 而那几行在事件流里从未出现过 —— 用户点开明细能看到，进度条却说他没跑过。
 *
 * `offset` 用 `created_at` 排序保证稳定：结果行是**只增不改**的（`ON CONFLICT DO NOTHING`），
 * 所以第 N 条永远是同一行。这里刻意不用 `LIMIT/OFFSET` 分页语义，
 * 而是「已经报过 N 条，就跳过 N 条」。
 */
async function loadNewCaseRows(
  runId: string,
  skip: number,
  limit: number,
): Promise<CaseRow[]> {
  const { rows } = await getPool().query<{
    case_key: string;
    score: string | null;
    passed: boolean | null;
    status: CaseResultStatus;
    latency_ms: number | null;
    rn: string;
  }>(
    `SELECT case_key, score, passed, status, latency_ms, rn FROM (
       SELECT case_key, score::text AS score, passed, status, latency_ms,
              row_number() OVER (ORDER BY created_at, case_key) AS rn
         FROM eval_case_results WHERE eval_run_id = $1
     ) t
     WHERE rn > $2 ORDER BY rn LIMIT $3`,
    [runId, skip, limit],
  );
  return rows.map((r) => ({
    caseKey: r.case_key,
    completedCount: Number(r.rn),
    score: r.score === null ? null : Number(r.score),
    passed: r.passed,
    status: r.status,
    latencyMs: r.latency_ms,
  }));
}
