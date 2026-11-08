/**
 * Baseline / RegressionGate 契约（`ED-08`，`BL-1`…`BL-4`）。
 *
 * 事实源：
 *  - `docs/facts/database-schema.md` §2.12–2.14
 *  - `docs/facts/product-overview.md` §5（`BL-1`…`BL-4`）
 *  - `docs/facts/pages-and-flows.md` PG-08 / PG-09
 *
 * 权限铁律（`BL-1` / `BL-3`）：
 *  - `ROLE-A` 只能**提名**（`nominated`）；
 *  - 只有 `ROLE-B` 能**确认 / 驳回**（`decided`）。
 *  契约层不复述角色（角色由会话上下文决定，不在请求体里），
 *  但把「提名」与「决定」拆成两个不同形状的入参，让越权调用在类型上就写不出来。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { IsoDateTime, Money, Score, Uuid } from './common.js';

// ---------------------------------------------------------------------------
// ED-08 · Baseline
// ---------------------------------------------------------------------------

/** 与 `ck_baselines_status` 一致。 */
export const BaselineStatus = z.enum(['NOMINATED', 'CONFIRMED', 'REJECTED']);
export type BaselineStatus = z.infer<typeof BaselineStatus>;

/**
 * 提名基线（`ROLE-A` 可用）。
 *
 * 刻意**不含** `status` 字段——提名必然是 `NOMINATED`，
 * 让调用方传 status 只会诱发出"研发直接提名并确认"的越权路径。
 */
export const BaselineNominate = z.object({
  datasetId: Uuid,
  evalRunId: Uuid,
  /** 提名理由，管理员确认时的主要判断依据。 */
  note: z
    .string()
    .max(2000)
    .refine((v) => v.trim().length > 0, { message: '提名理由不可为空' }),
});
export type BaselineNominate = z.infer<typeof BaselineNominate>;

/** 确认 / 驳回（仅 `ROLE-B`）。二选一，不存在「部分确认」。 */
export const BaselineDecision = z.object({
  approve: z.boolean(),
  /** 驳回理由。驳回时建议填写，确认时可省略。 */
  note: z.string().max(2000).optional(),
});
export type BaselineDecision = z.infer<typeof BaselineDecision>;

export const Baseline = z.object({
  id: Uuid,
  datasetId: Uuid,
  evalRunId: Uuid,
  status: BaselineStatus,
  note: z.string().nullable(),
  nominatedBy: z.string(),
  nominatedAt: IsoDateTime,
  /** 仅 CONFIRMED / REJECTED 时有值（`ck_baselines_decision` 强制）。 */
  decidedBy: z.string().nullable(),
  decidedAt: IsoDateTime.nullable(),
  /** 展示用冗余：被提名运行的关键指标，避免列表页 N+1 查询。 */
  runSummary: z
    .object({
      runName: z.string(),
      scoreOverall: Score.nullable(),
      passRate: Score.nullable(),
      finishedAt: IsoDateTime.nullable(),
    })
    .optional(),
});
export type Baseline = z.infer<typeof Baseline>;

/**
 * 某个评测集的基线解析结果。
 *
 * `confirmed` 为 null 是**一等状态**而非错误：
 * PG-08 必须据此渲染「尚未确认基线，本次对比仅供观察，不作为门禁依据」。
 */
export const BaselineResolution = z.object({
  datasetId: Uuid,
  confirmed: Baseline.nullable(),
  pendingNominations: z.number().int().min(0),
});
export type BaselineResolution = z.infer<typeof BaselineResolution>;

// ---------------------------------------------------------------------------
// RegressionGate（P1 / PG-09 门禁规则 Tab）
// ---------------------------------------------------------------------------

/** 可参与门禁判定的指标。与 `eval_runs` 的三个数一一对应。 */
export const GateMetric = z.enum(['score_overall', 'pass_rate', 'regression_pct']);
export type GateMetric = z.infer<typeof GateMetric>;

/**
 * 条件。
 *
 * `regression_pct` 是**相对已确认 baseline** 的退化百分比（`BL-2`），
 * 其 `value` 单位为百分点（如 5 = 退化超过 5% 则触发）。
 * 其余两个指标的 `value` 为绝对阈值，取值 [0,1]。
 */
export const GateCondition = z
  .object({
    metric: GateMetric,
    op: z.enum(['<', '>']),
    value: z.number(),
  })
  .refine((v) => v.metric !== 'regression_pct' || v.value >= 0, {
    path: ['value'],
    message: 'regression_pct 的阈值不得为负',
  })
  .refine((v) => v.metric === 'regression_pct' || (v.value >= 0 && v.value <= 1), {
    path: ['value'],
    message: '绝对指标（score_overall / pass_rate）的阈值必须落在 [0,1]',
  });
export type GateCondition = z.infer<typeof GateCondition>;

/** 门禁动作。`BLOCK` 阻断合流，`WARN` 仅告警。 */
export const GateAction = z.enum(['BLOCK', 'WARN']);
export type GateAction = z.infer<typeof GateAction>;

/**
 * 推送渠道。
 *
 * **只有 webhook URL，永不出现 GitHub token / PAT。**
 * 规则依据：`docs/工程规则.md` §9；实现边界见 PG-09 说明。
 * 契约层把它固定成 `kind` + `url` 两字段，任何"再塞一个 token 字段"的改动
 * 都会是显式的破坏性变更。
 */
export const GateChannel = z.object({
  kind: z.enum(['feishu', 'wecom', 'webhook']),
  url: z.string().url(),
});
export type GateChannel = z.infer<typeof GateChannel>;

export const RegressionGateCreate = z.object({
  name: z.string().min(1).max(120),
  datasetId: Uuid,
  /** null = 不限目标（`regression_gates.target_id` 可空）。 */
  targetId: Uuid.nullable().optional(),
  /** null = 用当前已确认基线；非 null = 固定到某次历史基线。 */
  baselineId: Uuid.nullable().optional(),
  condition: GateCondition,
  action: GateAction.default('BLOCK'),
  channels: z.array(GateChannel).default([]),
});
export type RegressionGateCreate = z.infer<typeof RegressionGateCreate>;

/**
 * 更新门禁规则。
 *
 * **刻意手写而非 `RegressionGateCreate.partial()`**：
 * `.partial()` 只把字段变成可选，不会剥掉字段内层的 `.default()`，
 * 于是 PATCH 里省略 `action` 时会被默认值静默改写成 `'BLOCK'`——
 * 用户只想改个名字，规则动作却被重置了。
 * 这里显式去掉两个默认值，语义才是真正的「不传即不改」。
 */
export const RegressionGateUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  datasetId: Uuid.optional(),
  targetId: Uuid.nullable().optional(),
  baselineId: Uuid.nullable().optional(),
  condition: GateCondition.optional(),
  action: GateAction.optional(),
  channels: z.array(GateChannel).optional(),
  isActive: z.boolean().optional(),
});
export type RegressionGateUpdate = z.infer<typeof RegressionGateUpdate>;

export const RegressionGate = z.object({
  id: Uuid,
  name: z.string(),
  datasetId: Uuid,
  targetId: Uuid.nullable(),
  baselineId: Uuid.nullable(),
  condition: GateCondition,
  action: GateAction,
  isActive: z.boolean(),
  channels: z.array(GateChannel),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RegressionGate = z.infer<typeof RegressionGate>;

// ---------------------------------------------------------------------------
// GateEvaluation（门禁执行留痕，不可变）
// ---------------------------------------------------------------------------

/**
 * 门禁判定明细。
 *
 * 同时保存 `baselineValue` 与 `currentValue` 与 `delta`：
 * 只存结论（通过/不通过）的话，事后无法回答"为什么没过"，
 * 而门禁恰恰是**最需要可申诉**的场景。
 */
export const GateEvaluationDetail = z.object({
  metric: GateMetric,
  baselineValue: z.number().nullable(),
  currentValue: z.number().nullable(),
  delta: z.number().nullable(),
  op: z.enum(['<', '>']),
  value: z.number(),
});
export type GateEvaluationDetail = z.infer<typeof GateEvaluationDetail>;

export const GateEvaluation = z.object({
  id: Uuid,
  gateId: Uuid,
  evalRunId: Uuid,
  passed: z.boolean(),
  detail: GateEvaluationDetail,
  createdAt: IsoDateTime,
});
export type GateEvaluation = z.infer<typeof GateEvaluation>;

// ---------------------------------------------------------------------------
// 对外门禁结果（`US-018` 的实现边界）
// ---------------------------------------------------------------------------

/**
 * **平台对外只交付这一坨 JSON。**
 *
 * 平台不写 PR 评论、不持有 GitHub PAT、不知道 PR 号——
 * 由 CI 侧（GitHub Actions）拉取本结构并自行决定如何评论。
 * 这是 `工程规则` §9 与 PG-09 的边界，不是"暂时没做"。
 */
export const GateResultEnvelope = z.object({
  schemaVersion: z.literal('1'),
  generatedAt: IsoDateTime,
  evalRunId: Uuid,
  runName: z.string(),
  datasetId: Uuid,
  datasetVersionId: Uuid,
  targetId: Uuid,
  targetVersionId: Uuid,
  /** 本次运行的核心指标，供 CI 直接引用。 */
  metrics: z.object({
    scoreOverall: Score.nullable(),
    passRate: Score.nullable(),
    coverage: Score.nullable(),
    costTotal: Money,
  }),
  /** 已确认基线指标；无基线时为 null（此时门禁结论不可作阻塞依据）。 */
  baseline: z
    .object({
      evalRunId: Uuid,
      scoreOverall: Score.nullable(),
      passRate: Score.nullable(),
    })
    .nullable(),
  /** 逐条门禁判定。空数组 = 未配置任何规则，CI 应视为不阻断。 */
  evaluations: z.array(
    z.object({
      gateId: Uuid,
      gateName: z.string(),
      action: GateAction,
      passed: z.boolean(),
      detail: GateEvaluationDetail,
    }),
  ),
  /** 只有存在 `action='BLOCK'` 且 `passed=false` 时为 'FAIL'。 */
  overall: z.enum(['PASS', 'FAIL', 'NO_GATE']),
});
export type GateResultEnvelope = z.infer<typeof GateResultEnvelope>;

/** 由 evaluations 推导总体结论，防止各调用点各算一遍。 */
export function deriveGateOverall(
  evaluations: ReadonlyArray<{ action: GateAction; passed: boolean }>,
): 'PASS' | 'FAIL' | 'NO_GATE' {
  if (evaluations.length === 0) return 'NO_GATE';
  const blocked = evaluations.some((e) => e.action === 'BLOCK' && !e.passed);
  return blocked ? 'FAIL' : 'PASS';
}
