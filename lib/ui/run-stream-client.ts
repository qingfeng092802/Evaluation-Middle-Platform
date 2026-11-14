/**
 * 前端进度状态机（Batch 3 · 交付物 4/5）。
 *
 * 页面只做三件事：开 `EventSource`、把收到的帧喂给 `applyFrame()`、把结果交给
 * `<LiveRunProgressBar />`。**所有计数语义都在本文件**，因为这里才是
 * 「重连后进度不倒退、不重复计数」真正会出错的地方 ——
 *
 *  - **不按事件累加**（`+1` 一次就多计一遍，只有断过线的人看得见）；
 *  - **不接受更小的 `completedCount`**（重连时旧帧会让进度条往回跳）；
 *  - **同一 `caseKey` 只计一次**（`snapshot` 已包含它，事件再来一次不能翻倍）。
 *
 * `PROGRESS_RESUME_POLICY.mode = 'snapshot_only'` 在这里落成两句话：
 * 1. `snapshot` **替换**全部计数，永远不累加；
 * 2. 重连的第一步是 `GET /api/runs/:id`（页面做），而不是向服务端要回放。
 *
 * 另外刻意不把「每来一条 Case 就播报」写进 `aria-live`：300 条 Case 会把读屏刷爆，
 * 只有**连接态变化**与**每 10% 里程碑**才配一次播报（`DESIGN.md` §4.2）。
 */
import type { CaseResultStatus, EvalProgressFrame, RunStatus } from '@eval-platform/contracts';

/** `DESIGN.md` §4.2 的连接三态。 */
export type StreamConnection = 'connected' | 'reconnecting' | 'disconnected';

/** 最新一条 Case 的摘要（`CaseEvent` 里那几个可空字段）。 */
export interface StreamLatestCase {
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly latencyMs: number | null;
}

export interface StreamProgress {
  readonly completedCount: number;
  readonly totalCount: number;
  readonly failedCount: number;
  readonly runStatus: RunStatus;
  readonly latest: StreamLatestCase | null;
  /** 已计入的 `caseKey`。`snapshot` 时清空（快照即真相，旧集合不再可信）。 */
  readonly seen: ReadonlySet<string>;
}

export const INITIAL_STREAM_PROGRESS: StreamProgress = {
  completedCount: 0,
  totalCount: 0,
  failedCount: 0,
  // 连上之前先按「等待调度」显示：PENDING 的文案是「等待调度」而不是 `0 / 0`
  runStatus: 'PENDING',
  latest: null,
  seen: new Set<string>(),
};

/** 已完成计数与 `finalizeRun` 同口径：`succeeded + failed`（`skipped` 已含在 failed 里）。 */
function completedOf(counts: {
  succeededCases: number;
  failedCases: number;
  skippedCases: number;
}): number {
  return counts.succeededCases + counts.failedCases;
}

function latestOf(data: {
  score: number | null;
  passed: boolean | null;
  latencyMs: number | null;
}): StreamLatestCase {
  return { score: data.score, passed: data.passed, latencyMs: data.latencyMs };
}

/**
 * 吃一帧，返回新的进度。
 *
 * **纯函数**：同样一帧喂进去永远得到同样的结果，页面因此可以在 StrictMode 的
 * 双次 effect、重连、`reload()` 之间反复重放而不会漂移。
 */
export function applyFrame(state: StreamProgress, frame: EvalProgressFrame): StreamProgress {
  const data = frame.data;

  if (data.type === 'snapshot') {
    // 快照即真相：**替换**，不累加；`seen` 一并重置，否则同一条 Case 的陈旧事件
    // 会让 `failedCount` 在重连后翻倍。
    return {
      completedCount: completedOf(data.counts),
      totalCount: data.counts.totalCases,
      failedCount: data.counts.failedCases,
      runStatus: data.status,
      latest: null,
      seen: new Set<string>(),
    };
  }

  if (data.type === 'status') {
    return { ...state, runStatus: data.to };
  }

  if (data.type === 'case') {
    // 重复或更旧的帧：不是「再算一次」，而是直接丢弃。
    // 单调性是断开重连后仍然可信的唯一依据（服务端不会回放，只会给更新的快照）。
    //
    // 判据是 `<=` 而不是 `<`：`completedCount` 是服务端按结果行的行号取的，
    // **同一行永远同一个数**。所以「等于当前值」一定是已计入过的帧
    // （典型来源：重连后快照已包含它，事件又在缓冲里重放了一次），
    // 若放行就会把 `failedCount` 多加一遍 —— 进度条显示「已完成 1 / 10，失败 2」。
    if (state.seen.has(data.caseKey)) return state;
    if (data.completedCount <= state.completedCount) return state;

    const failed = isFailedStatus(data.status);
    return {
      completedCount: data.completedCount,
      // 以事件里带的总数为准，但绝不让它退化成 0（`snapshot` 之前到达的 case 帧
      // 里 `totalCount` 也是真的，没有理由丢掉它）
      totalCount: Math.max(state.totalCount, data.totalCount),
      failedCount: state.failedCount + (failed ? 1 : 0),
      runStatus: state.runStatus,
      latest: latestOf(data),
      seen: new Set(state.seen).add(data.caseKey),
    };
  }

  // `heartbeat` / `error`：不改进度。单条失败由 `status` 与计数表达，
  // `error` 只是描述某一条出了什么事，把它当成「重置」是过度解读。
  return state;
}

/** 与 `caseStatusTone()` 同口径：非 `OK` 一律算失败（与后端 failed 口径一致）。 */
function isFailedStatus(s: CaseResultStatus): boolean {
  return s !== 'OK';
}

const CONNECTION_LABEL: Readonly<Record<StreamConnection, string>> = {
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '已断开',
};

const CONNECTION_TONE: Readonly<Record<StreamConnection, 'running' | 'warn' | 'fail'>> = {
  connected: 'running',
  reconnecting: 'warn',
  disconnected: 'fail',
};

/** 连接指示灯文案（逐字取自 `DESIGN.md` §4.2）。 */
export function connectionLabel(c: StreamConnection): string {
  return CONNECTION_LABEL[c];
}

/** 连接指示灯色调。`running` 才呼吸，其余两态静态（大面积脉冲是闪烁风险）。 */
export function connectionTone(c: StreamConnection): 'running' | 'warn' | 'fail' {
  return CONNECTION_TONE[c];
}

/** 当前进度落在哪个 10% 里程碑（向下取整）。 */
export function milestoneOf(completed: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const pct = (Math.max(0, completed) / total) * 100;
  return Math.min(100, Math.floor(pct / 10) * 10);
}

export interface AnnounceState {
  readonly connection: StreamConnection;
  readonly milestone: number;
}

/**
 * 这一帧要不要播报给读屏。
 *
 * 只播三种：连接态变化、跨到新的 10% 里程碑、里程碑**倒退**（后者是异常，
 * 静默会让用户以为一切正常）。每一条 Case 都不播 —— 300 条会把读屏刷爆。
 */
export function shouldAnnounce(prev: AnnounceState, next: AnnounceState): boolean {
  if (prev.connection !== next.connection) return true;
  return prev.milestone !== next.milestone;
}
