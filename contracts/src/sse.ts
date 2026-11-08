/**
 * SSE 事件契约。
 *
 * 事实源：`docs/facts/technical-solution.md` §3.4。
 *
 * 五类事件：`snapshot` / `case` / `status` / `heartbeat` / `error`。
 *
 * 三条必须遵守的传输约束：
 *  1. **不做事件回放。** 重连时服务端只返回 `snapshot`，快照即真相；
 *  2. **客户端重连第一步必须是拉全量快照**（`GET /api/runs/:id`），再重新订阅；
 *  3. `heartbeat` 每 15s。超过 30s 无任何事件，客户端应主动断开重连。
 *
 * 为什么没有 `delta` 事件：`snapshot` 已含全量计数，增量事件一旦丢失
 * 就会让进度条与真实进度永久错位，而 `LISTEN/NOTIFY` 本身不保证投递。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { CaseResultStatus, IsoDateTime, RunStatus, Score, Uuid } from './common.js';
import { EvalRunCounts, EvalRunMetrics } from './run.js';

// ---------------------------------------------------------------------------
// 事件载荷
// ---------------------------------------------------------------------------

/** 全量运行状态。连接建立 / 重连后首个事件，也是唯一可被信任的真相来源。 */
export const SnapshotEvent = z.object({
  type: z.literal('snapshot'),
  runId: Uuid,
  status: RunStatus,
  counts: EvalRunCounts,
  metrics: EvalRunMetrics,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type SnapshotEvent = z.infer<typeof SnapshotEvent>;

/**
 * 单条 Case 完成摘要。
 *
 * 刻意只带摘要（`querySummary` 而非全文、不含 `operatorScores`）：
 * 300 条 Case 的完整 payload 会把单条事件推到几十 KB，
 * 而列表页只需要"多了这一行"。详情走 `GET /api/runs/:id/cases/:caseId`。
 */
export const CaseEvent = z.object({
  type: z.literal('case'),
  runId: Uuid,
  caseKey: z.string(),
  /** 单调递增的已完成计数，客户端据此渲染进度条，不必自己累加。 */
  completedCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  score: Score.nullable(),
  passed: z.boolean().nullable(),
  status: CaseResultStatus,
  latencyMs: z.number().int().min(0).nullable(),
});
export type CaseEvent = z.infer<typeof CaseEvent>;

/** 状态徽章变更。终态到来时这是最后一个业务事件。 */
export const StatusEvent = z.object({
  type: z.literal('status'),
  runId: Uuid,
  from: RunStatus,
  to: RunStatus,
  at: IsoDateTime,
});
export type StatusEvent = z.infer<typeof StatusEvent>;

/** 保活。无业务含义，仅用于让代理/浏览器不判定连接空闲。 */
export const HeartbeatEvent = z.object({
  type: z.literal('heartbeat'),
  at: IsoDateTime,
});
export type HeartbeatEvent = z.infer<typeof HeartbeatEvent>;

/**
 * 运行异常。
 *
 * 注意：`error` 事件**不终止连接**——它描述的是某条 Case 或某次网关调用的失败，
 * 运行本身可能仍在继续。整体失败用 `status → FAILED` 表达。
 */
export const ErrorEvent = z.object({
  type: z.literal('error'),
  runId: Uuid,
  code: z.string(),
  message: z.string(),
  /** 关联的 Case（若错误针对具体一条）。 */
  caseKey: z.string().optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/** 判别联合：客户端 `switch (evt.type)` 即可穷尽处理。 */
export const RunStreamEvent = z.discriminatedUnion('type', [
  SnapshotEvent,
  CaseEvent,
  StatusEvent,
  HeartbeatEvent,
  ErrorEvent,
]);
export type RunStreamEvent = z.infer<typeof RunStreamEvent>;

// ---------------------------------------------------------------------------
// 传输细节
// ---------------------------------------------------------------------------

/** `event:` 字段取值，与上面的 `type` 一一对应（EventSource 靠它分派）。 */
export const SSE_EVENT_NAMES = [
  'snapshot',
  'case',
  'status',
  'heartbeat',
  'error',
] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/** 心跳间隔（毫秒）。 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 客户端静默超时（毫秒）。
 * 定为心跳间隔的 2 倍：允许一次心跳丢失，两次都没等到即视为连接已死。
 */
export const SSE_CLIENT_SILENCE_TIMEOUT_MS = 30_000;

/**
 * 重连后客户端必须执行的动作序列。
 * 写成常量而非注释，是为了让前端与文档共用同一段文字。
 */
export const SSE_RECONNECT_PROCEDURE = [
  '1. 断开旧连接，清除本地累加状态',
  '2. GET /api/runs/:id 拉取全量快照（快照即真相）',
  '3. 重新订阅 /api/runs/:id/stream，丢弃首个 snapshot 之外的陈旧事件',
] as const;

/**
 * 解析一行 SSE 原始文本为事件（服务端与测试共用）。
 *
 * 只处理单行 `data:`；项目内 event 负载均为单行 JSON，多行 `data:` 不在契约内。
 */
export function parseSseDataLine(line: string): RunStreamEvent | null {
  if (!line.startsWith('data:')) return null;
  const raw = line.slice(5).trim();
  if (raw.length === 0) return null;
  const parsed = RunStreamEvent.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}
