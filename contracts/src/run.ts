/**
 * EvalRun / EvalCaseResult 契约（`ED-06` / `ED-07`）+ 状态机。
 *
 * 事实源：
 *  - `docs/facts/database-schema.md` §2.9 / §2.11，§3.3 触发器
 *  - `docs/facts/technical-solution.md` §2（OPEN-1…OPEN-5）、§3.3 终态判定
 *  - `docs/facts/pages-and-flows.md` §4（`RS-01`…`RS-06`）
 *
 * 不可变红线：EvalRun 进入终态后整行冻结，CaseResult 一律不可变。
 * 重跑 = 新建 EvalRun，永不覆盖（`PT-2`）。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import {
  CaseResultStatus,
  IsoDateTime,
  Money,
  RunStatus,
  Score,
  Uuid,
  isTerminalRunStatus,
} from './common.js';
import { OperatorScoreList, RunEvaluatorInput } from './evaluator.js';

// ---------------------------------------------------------------------------
// 触发来源（`eval_runs.trigger_source`）
// ---------------------------------------------------------------------------

/**
 * 谁发起了这次运行。
 *
 * `MANUAL` = 人在 PG-01 / PG-02 点击发起；`CI_WEBHOOK` = 流水线调用 API 发起。
 * 两者**只影响溯源与统计，不影响执行逻辑**——刻意如此，
 * 否则会出现"CI 跑出的分数和人工跑的不一样"这类无法解释的偏差。
 */
export const TriggerSource = z.enum(['MANUAL', 'CI_WEBHOOK']);
export type TriggerSource = z.infer<typeof TriggerSource>;

// ---------------------------------------------------------------------------
// 可复现性快照（OPEN-4）
// ---------------------------------------------------------------------------

/**
 * `eval_runs.reproducibility`。
 *
 * `cachePolicy` 恒为 `'none'`——首版不做响应缓存，且这是**锁死口径**：
 * 若哪天想加缓存，必须同时改本契约、`technical-solution.md` OPEN-4、
 * 以及 PG-03 的对外文案，而不是悄悄改一个字面量。
 *
 * 外对表述红线：「EvalRun 可解释，不可复现。」
 */
export const Reproducibility = z.object({
  temperature: z.number().nullable(),
  topP: z.number().nullable(),
  maxTokens: z.number().int().nullable(),
  seed: z.number().int().nullable(),
  runnerVersion: z.string(),
  /** 厂商侧的模型版本串（如 `gpt-4o-2024-11-20`），用于事后追责。 */
  modelVersionString: z.string().nullable(),
  promptTemplateHash: z.string(),
  cachePolicy: z.literal('none'),
});
export type Reproducibility = z.infer<typeof Reproducibility>;

// ---------------------------------------------------------------------------
// 配置快照（PT-1 的物理载体）
// ---------------------------------------------------------------------------

/**
 * 建 run 时一次性写入的完整快照。
 * 执行期**不再回查模板表**（`technical-solution.md` §3.2），
 * 因此模板日后改版绝不影响历史运行。
 */
export const RunConfigSnapshot = z.object({
  datasetVersionId: Uuid,
  datasetContentHash: z.string(),
  targetVersionId: Uuid,
  targetKind: z.enum(['t1_prompt', 't2_http']),
  /** 算子快照，顺序即执行顺序。 */
  evaluators: z.array(RunEvaluatorInput),
  /** 用到的模型单价快照（`model_prices` 的当时值），成本计算唯一依据。 */
  priceSnapshot: z.array(
    z.object({
      modelProviderId: Uuid,
      modelId: z.string(),
      inputPricePer1k: Money,
      outputPricePer1k: Money,
      currency: z.enum(['CNY', 'USD']),
      effectiveFrom: IsoDateTime,
    }),
  ),
});
export type RunConfigSnapshot = z.infer<typeof RunConfigSnapshot>;

// ---------------------------------------------------------------------------
// 发起评测（PG-02 提交体）
// ---------------------------------------------------------------------------

/**
 * 发起评测。
 *
 * 服务端必须重新执行 PG-02 的三条阻塞校验再落库——
 * 前端禁用按钮不等于后端安全（用户可以直接打 API）。
 */
export const EvalRunCreate = z.object({
  name: z
    .string()
    .max(120)
    .refine((v) => v.trim().length > 0, { message: '评测名称不可为空白' }),
  datasetVersionId: Uuid,
  targetVersionId: Uuid,
  /** 必须 ≥ 1，对应 `ck_eval_runs_conc`。 */
  concurrency: z.number().int().positive().max(32).default(4),
  /** 至少一个算子，对应 PG-02「请至少配置一个评测算子」。 */
  evaluators: z.array(RunEvaluatorInput).min(1),
  /**
   * 可选的对比对象（运行期事实，非 `baselines` 的正式基线）。
   * 服务端必须校验它属于同一 `datasetVersionId`，否则逐条对齐无意义。
   */
  baselineRunId: Uuid.optional(),
  /**
   * 触发来源。CI 调用时必须显式传 `CI_WEBHOOK`；
   * 缺省 `MANUAL`（人工在 PG-01/02 发起）。
   */
  triggerSource: TriggerSource.default('MANUAL'),
});
export type EvalRunCreate = z.infer<typeof EvalRunCreate>;

/** 中止请求（`US-014`）。不回写已完成结果，只置标记。 */
export const EvalRunCancel = z.object({
  reason: z.string().max(500).optional(),
});
export type EvalRunCancel = z.infer<typeof EvalRunCancel>;

// ---------------------------------------------------------------------------
// EvalRun（只读视图）
// ---------------------------------------------------------------------------

/**
 * 三个数不可互相替代（OPEN-5）：
 *  - `scoreOverall` 质量，`NULL` = 无可评样本，**绝不用 0 冒充**；
 *  - `passRate` 可用性，失败计入分母；
 *  - `coverage` 完整性，`succeeded / total`。
 */
export const EvalRunMetrics = z.object({
  scoreOverall: Score.nullable(),
  passRate: Score.nullable(),
  coverage: Score.nullable(),
  latencyP50Ms: z.number().int().min(0).nullable(),
  latencyP95Ms: z.number().int().min(0).nullable(),
  tokensInTotal: z.number().int().min(0),
  tokensOutTotal: z.number().int().min(0),
  /** 成本分列（OPEN-3）。`costTotal` 由数据库 STORED 列计算，不由前端累加。 */
  costTarget: Money,
  costJudge: Money,
  costTotal: Money,
});
export type EvalRunMetrics = z.infer<typeof EvalRunMetrics>;

export const EvalRunCounts = z.object({
  totalCases: z.number().int().min(0),
  succeededCases: z.number().int().min(0),
  failedCases: z.number().int().min(0),
  skippedCases: z.number().int().min(0),
});
export type EvalRunCounts = z.infer<typeof EvalRunCounts>;

export const EvalRun = z.object({
  id: Uuid,
  name: z.string(),
  status: RunStatus,
  datasetVersionId: Uuid,
  targetVersionId: Uuid,
  /** 展示用冗余标签（如 `客服QA评测集 @ v3`），非表字段。 */
  datasetLabel: z.string(),
  targetLabel: z.string(),
  concurrency: z.number().int().positive(),
  counts: EvalRunCounts,
  metrics: EvalRunMetrics,
  /** 谁发起的（`eval_runs.trigger_source`）。 */
  triggerSource: TriggerSource,
  /** 本次运行发起时选择的对比对象；`null` = 未指定。与 `baselines` 的正式基线无关。 */
  baselineRunId: Uuid.nullable(),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  /** 非 null ⇒ 已收到中止请求（PG-03「中止评测」）。 */
  cancelRequestedAt: IsoDateTime.nullable(),
});
export type EvalRun = z.infer<typeof EvalRun>;

/** 详情页 = 概要 + 快照 + 可复现性 + 算子清单（PG-03 元数据栏）。 */
export const EvalRunDetail = EvalRun.extend({
  configSnapshot: RunConfigSnapshot,
  reproducibility: Reproducibility,
  runnerVersion: z.string(),
  /** 快照后的算子清单，顺序即执行顺序。 */
  evaluators: z.array(
    z.object({
      evaluatorKey: z.string(),
      evaluatorVersion: z.number().int().min(1),
      kind: z.enum(['rule', 'judge']),
      weight: z.number().min(0),
      passThreshold: z.number().min(0).max(1).nullable(),
      orderIndex: z.number().int().min(0),
    }),
  ),
});
export type EvalRunDetail = z.infer<typeof EvalRunDetail>;

// ---------------------------------------------------------------------------
// CaseResult（只读）
// ---------------------------------------------------------------------------

/**
 * 单条结果。
 *
 * 不变量（数据库 CHECK 强制）：
 *  - `status === 'OK'` ⇒ `score !== null`；
 *  - `status !== 'OK'` ⇒ `score === null`。
 * 契约层用 `.refine` 复述一次，让前端在拿到坏数据时立刻炸而不是渲染 `NaN`。
 *
 * 用 `.refine` 而非 `.superRefine` + `z.ZodIssueCode`：后者是 Zod v3 专属 API，
 * v4 已移除，会破坏 README 声明的双兼容子集。
 */
export const EvalCaseResult = z
  .object({
    id: Uuid,
    evalRunId: Uuid,
    datasetCaseId: Uuid,
    /** 冗余存储，避免逐条对比时多一次 join。 */
    caseKey: z.string().min(1),
    /** 列表页摘要用的 query 前 N 字。 */
    querySummary: z.string(),

    outputText: z.string().nullable(),
    outputRaw: z.record(z.string(), z.unknown()).nullable(),
    retrievalReturned: z.record(z.string(), z.unknown()).nullable(),

    status: CaseResultStatus,
    errorMessage: z.string().nullable(),
    score: Score.nullable(),
    /** `OPEN-2`：所有算子均通过才为 true；无可用算子时可能为 null。 */
    passed: z.boolean().nullable(),
    /** 完整保存每个算子结论，冲突不隐藏。 */
    operatorScores: OperatorScoreList.nullable(),
    judgeReasoning: z.string().nullable(),

    latencyMs: z.number().int().min(0).nullable(),
    tokensIn: z.number().int().min(0),
    tokensOut: z.number().int().min(0),
    costTarget: Money,
    costJudge: Money,
    costTotal: Money,
    createdAt: IsoDateTime,
  })
  .refine((v) => v.status !== 'OK' || v.score !== null, {
    path: ['score'],
    message: "status='OK' 时 score 不得为 null（对齐 ck_eval_case_results_ok_score）",
  })
  .refine((v) => v.status === 'OK' || v.score === null, {
    path: ['score'],
    message: "status<>'OK' 时 score 必须为 null（评分失败不得伪造分数）",
  });
export type EvalCaseResult = z.infer<typeof EvalCaseResult>;

// ---------------------------------------------------------------------------
// 状态机辅助（与数据库触发器同规则，供应用层前置校验）
// ---------------------------------------------------------------------------

/**
 * 终态判定。
 *
 * 服务端在置终态前必须按此规则计算，不得依赖客户端上报：
 *   全部 OK（succeeded === total）→ COMPLETED
 *   有非 OK 且 succeeded > 0        → PARTIAL_FAILED
 *   succeeded === 0                 → FAILED
 *   已请求中止                       → CANCELLED（优先级最高，保留已完成结果）
 *
 * 注意 `skipped` 不算「成功」：它使 succeeded ≠ total，因此结果落在 PARTIAL_FAILED，
 * 而不是 COMPLETED——一个跳过了一半 Case 的运行声称 COMPLETED 会误导人。
 * （`skipped` 已包含在 `totalCases` 中，故无需单独入参即可判定。）
 */
export function deriveTerminalStatus(counts: {
  totalCases: number;
  succeededCases: number;
  cancelled: boolean;
}): RunStatus {
  if (counts.cancelled) return 'CANCELLED';
  if (counts.succeededCases === 0) return 'FAILED';
  return counts.succeededCases === counts.totalCases ? 'COMPLETED' : 'PARTIAL_FAILED';
}

/**
 * 终态下 `scoreOverall` 必须为 null 的情形。
 * 与 `ck_eval_runs_failed_null_score` 完全一致。
 */
export function mustNullScore(status: RunStatus): boolean {
  return status === 'FAILED';
}

/** `FAILED` 时 UI 必须把 `coverage` 提到主指标位（technical-solution §2 OPEN-5 UI 约束）。 */
export function primaryMetricOf(status: RunStatus): 'scoreOverall' | 'coverage' {
  return status === 'FAILED' ? 'coverage' : 'scoreOverall';
}

/** 终态后任何字段不得再改——与 `eval_runs_guard()` 一致。 */
export function assertMutable(status: RunStatus): void {
  if (isTerminalRunStatus(status)) {
    throw new Error(`EvalRun 已处于终态 ${status}，不可再修改`);
  }
}

/** PG-03 / PG-01 的「中止」按钮可用性。 */
export function canCancel(status: RunStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

/** PG-01 / PG-03 的「提名基线」按钮可用性（BL-3：研发只能提名）。 */
export function canNominateBaseline(status: RunStatus): boolean {
  return status === 'COMPLETED' || status === 'PARTIAL_FAILED';
}
