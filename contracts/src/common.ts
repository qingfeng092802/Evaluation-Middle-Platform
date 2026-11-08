/**
 * 共享原语与错误契约。
 *
 * 事实源：
 *  - docs/facts/database-schema.md §0「全局约定」
 *  - docs/facts/technical-solution.md §2（评分与成本口径）
 *
 * ⚠️ 本文件未经过编译验证，详见 README.md「编译状态声明」。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 标识
// ---------------------------------------------------------------------------

/** UUID v4 主键。数据库侧为 `uuid DEFAULT gen_random_uuid()`。 */
export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/** 工作区占位。首版固定 'default'，不启用权限（product-overview.md §2.2）。 */
export const WORKSPACE_DEFAULT = 'default' as const;

/** RFC3339 / ISO8601 时间串。数据库侧为 `timestamptz`。 */
export const IsoDateTime = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

// ---------------------------------------------------------------------------
// 数值
// ---------------------------------------------------------------------------

/**
 * 归一化分数，取值区间 [0, 1]。
 * 数据库侧为 `numeric(10,6)`——禁止 float（database-schema.md §0）。
 */
export const Score = z.number().min(0).max(1);
export type Score = z.infer<typeof Score>;

/**
 * 金额。数据库侧为 `numeric(18,8)`。
 * 注意：传输层用 number，落库前必须由 ORM 以 numeric 处理，禁止参与浮点累加。
 */
export const Money = z.number().min(0);
export type Money = z.infer<typeof Money>;

/** 人民币分为单位以外的场景一律显式带币种。 */
export const Currency = z.enum(['CNY', 'USD']);
export type Currency = z.infer<typeof Currency>;

/** 单条 Case 的三级状态（database-schema.md §2.11）。 */
export const CaseResultStatus = z.enum([
  'OK',
  'FAILED',
  'TIMEOUT',
  'PARSE_ERROR',
  'QUOTA_EXCEEDED',
  'SKIPPED',
]);
export type CaseResultStatus = z.infer<typeof CaseResultStatus>;

/**
 * EvalRun 六态（pages-and-flows.md §4.1）。
 *
 * RS-05 `FAILED` 与 RS-04 `PARTIAL_FAILED` 必须区分：
 * 前者成功数为 0（配置错误），后者成功数 > 0。
 */
export const RunStatus = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PARTIAL_FAILED',
  'FAILED',
  'CANCELLED',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** 终态集合。进入后整行冻结（database-schema.md §3.3）。 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'COMPLETED',
  'PARTIAL_FAILED',
  'FAILED',
  'CANCELLED',
] as const;

export function isTerminalRunStatus(s: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}

/**
 * 合法状态流转表（database-schema.md §3.3）。
 * 数据库触发器会强制同一规则；此处供应用层前置校验，避免无谓的写入失败。
 */
export const ALLOWED_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  PARTIAL_FAILED: [],
  FAILED: [],
  CANCELLED: [],
} as const;

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_RUN_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/**
 * 分页响应体统一形态。
 *
 * 刻意**不**写成泛型工具函数（`PageOf<T>`）：泛型参数需要标注 `z.ZodTypeAny`，
 * 而该类内部类型在 Zod v3 → v4 之间签名有变动，属 README 声明的「双兼容风险点」。
 * 各实体模块各自声明具体分页结构，代价是多几行，收益是版本切换零成本。
 */
export const PageMeta = z.object({
  nextCursor: z.string().nullable(),
  total: z.number().int().min(0).optional(),
});
export type PageMeta = z.infer<typeof PageMeta>;

/** JSON 对象。刻意用两参数 `z.record(keyType, valueType)` —— v3.20+ 与 v4 均支持。 */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

// ---------------------------------------------------------------------------
// 错误契约
// ---------------------------------------------------------------------------

/**
 * 统一错误码。
 *
 * BLOCKED_* 对应 PG-02 的三条阻塞校验（pages-and-flows.md §1 PG-02）。
 */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'IMMUTABLE_VIOLATION',
  'ILLEGAL_STATE_TRANSITION',
  'BLOCKED_NO_PROVIDER_CREDENTIALS',
  'BLOCKED_NO_EVALUATORS',
  'BLOCKED_NO_RETRIEVAL_ANNOTATION',
  'GATEWAY_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** 面向用户的可执行提示，直接用于界面展示。 */
  hint: z.string().optional(),
  details: JsonObject.optional(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

export const ErrorResponse = z.object({ error: ApiError });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
