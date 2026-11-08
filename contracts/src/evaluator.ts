/**
 * Evaluator / RunEvaluator 契约（`ED-04`）。
 *
 * 事实源：
 *  - `docs/facts/database-schema.md` §2.8（模板侧）、§2.10（实例侧）
 *  - `docs/facts/pages-and-flows.md` PG-02 步骤 3、PG-07
 *
 * `ED-04` 的两侧必须区分清楚：
 *  - **模板侧**（`evaluators` 表，P1 建页 PG-07）：全局可改；
 *  - **实例侧**（`run_evaluators` 表，建 run 时写入）：`config` 是快照，
 *    模板日后被改版也不影响历史 EvalRun。这是 `PT-1` 能兑现的关键。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';

/**
 * 内置算子 `key`。P0 必须全部实现（`工程规则` §4 要求 6 个算子各有 golden test）。
 *
 * 三个检索算子（recall_at_k / mrr / ndcg_at_k）依赖 `dataset_cases.retrieval.relevant`，
 * 缺标注即不可用——这条依赖在 `dataset.ts` 的 `RetrievalReadiness` 与本文件的
 * `EVALUATOR_REQUIRES_RETRIEVAL` 双向表达。
 */
export const BuiltinEvaluatorKey = z.enum([
  'recall_at_k',
  'mrr',
  'ndcg_at_k',
  'json_schema',
  'regex',
  'numeric_fidelity',
]);
export type BuiltinEvaluatorKey = z.infer<typeof BuiltinEvaluatorKey>;

/** 用户自定义裁判模板的 key 形如 `judge.<slug>`，与内置 key 不冲突。 */
export const JudgeEvaluatorKey = z.string().min(1);
export type JudgeEvaluatorKey = z.infer<typeof JudgeEvaluatorKey>;

export const EvaluatorKind = z.enum(['rule', 'judge']);
export type EvaluatorKind = z.infer<typeof EvaluatorKind>;

/** 哪些内置算子必须有 retrieval 标注。前端据此禁用按钮，后端据此拒绝启动。 */
export const EVALUATOR_REQUIRES_RETRIEVAL: Readonly<
  Record<BuiltinEvaluatorKey, boolean>
> = {
  recall_at_k: true,
  mrr: true,
  ndcg_at_k: true,
  json_schema: false,
  regex: false,
  numeric_fidelity: false,
} as const;

// ---------------------------------------------------------------------------
// 内置规则算子 —— 各自参数
// ---------------------------------------------------------------------------

/** `recall_at_k`：Top-K 召回集合覆盖了多少「相关」文档。 */
export const RecallAtKConfig = z.object({
  key: z.literal('recall_at_k'),
  /** K 值，必须 ≥ 1。 */
  k: z.number().int().positive(),
  /** 相关性门槛：`grade >= 该值` 才算「相关」。缺省 1。 */
  gradeThreshold: z.number().int().min(0).default(1),
});
export type RecallAtKConfig = z.infer<typeof RecallAtKConfig>;

/** `mrr`：第一个相关文档的倒数排名。 */
export const MrrConfig = z.object({
  key: z.literal('mrr'),
  gradeThreshold: z.number().int().min(0).default(1),
});
export type MrrConfig = z.infer<typeof MrrConfig>;

/** `ndcg_at_k`：带相关性等级的折损累积增益。 */
export const NdcgAtKConfig = z.object({
  key: z.literal('ndcg_at_k'),
  k: z.number().int().positive(),
  /** 折损函数，`standard` = log2(i+1)。首版不开放自定义，避免口径漂移。 */
  gainFormula: z.literal('standard').default('standard'),
});
export type NdcgAtKConfig = z.infer<typeof NdcgAtKConfig>;

/**
 * `json_schema`：输出的 JSON 是否符合给定 Schema。
 *
 * 只做**结构**校验，不做业务语义校验——语义交给裁判算子。
 * Schema 以 JSON 对象形式内联快照，避免引用外部文件导致的漂移。
 */
export const JsonSchemaConfig = z.object({
  key: z.literal('json_schema'),
  /** 内联 JSON Schema（draft-07 子集，由 ajv 执行）。 */
  schema: z.record(z.string(), z.unknown()),
  /** 校验前是否先从输出中抽取 JSON 代码块。 */
  extractFromText: z.boolean().default(true),
});
export type JsonSchemaConfig = z.infer<typeof JsonSchemaConfig>;

/** `regex`：输出是否命中给定正则。 */
export const RegexConfig = z.object({
  key: z.literal('regex'),
  pattern: z.string().min(1),
  /** 大小写敏感，缺省 false（中文场景大小写通常无意义，英文场景应显式打开）。 */
  caseSensitive: z.boolean().default(false),
  /** 是否要求 >=1 次命中；false 时表示「必须不命中」（用于禁用词检查）。 */
  shouldMatch: z.boolean().default(true),
});
export type RegexConfig = z.infer<typeof RegexConfig>;

/**
 * `numeric_fidelity`：输出中的数值与参考答案数值是否保真。
 *
 * 依据 `dataset_cases.reference.reference_facts`（key → value）。
 */
export const NumericFidelityConfig = z.object({
  key: z.literal('numeric_fidelity'),
  /** 相对容差，如 0.01 = 1%。`numeric(10,6)` 落库。 */
  tolerance: z.number().min(0).max(1).default(0.01),
  /** 缺失某个 reference fact 时算通过还是失败。默认失败（严苛）。 */
  missingFails: z.boolean().default(true),
});
export type NumericFidelityConfig = z.infer<typeof NumericFidelityConfig>;

/** 六个规则算子的判别联合。 */
export const RuleEvaluatorConfig = z.discriminatedUnion('key', [
  RecallAtKConfig,
  MrrConfig,
  NdcgAtKConfig,
  JsonSchemaConfig,
  RegexConfig,
  NumericFidelityConfig,
]);
export type RuleEvaluatorConfig = z.infer<typeof RuleEvaluatorConfig>;

// ---------------------------------------------------------------------------
// LLM 裁判算子
// ---------------------------------------------------------------------------

/**
 * 裁判算子配置。
 *
 * `modelProviderId` + `modelId` 指向被用作裁判的模型——**裁判成本单独入账**
 * （`OPEN-3`：`cost_judge`），绝不可与 `cost_target` 混列。
 */
export const JudgeEvaluatorConfig = z.object({
  key: z.literal('judge'),
  modelProviderId: Uuid,
  modelId: z.string().min(1),
  /** 评分 Prompt，必须包含对 `{{input}}` / `{{output}}` / `{{reference}}` 的引用。 */
  promptTemplate: z.string().min(1),
  /** 分值区间上界（下界恒为 0）。首版支持 1 / 5 / 10 三档。 */
  scaleMax: z.union([z.literal(1), z.literal(5), z.literal(10)]).default(1),
  /** 通过阈值，按 scaleMax 归一化到 [0,1] 后存储。 */
  passThreshold: z.number().min(0).max(1).default(0.6),
  temperature: z.number().min(0).max(2).default(0),
  maxTokens: z.number().int().positive().optional(),
});
export type JudgeEvaluatorConfig = z.infer<typeof JudgeEvaluatorConfig>;

/**
 * 任意算子的配置（模板侧 / 实例侧通用）。
 *
 * 用 `z.union` 而非 `discriminatedUnion`：judge 的判别键是字面量 `'judge'`，
 * 与规则算子的 `BuiltinEvaluatorKey` 不在同一取值域上，判别联合无法容纳。
 * 代价是报错信息不如判别联合精确——可接受，因为 judge 只有一个分支。
 */
export const EvaluatorConfig = z.union([RuleEvaluatorConfig, JudgeEvaluatorConfig]);
export type EvaluatorConfig = z.infer<typeof EvaluatorConfig>;

/** 从配置反推 kind，避免调用方重复传参导致两侧不一致。 */
export function evaluatorKindOf(config: EvaluatorConfig): EvaluatorKind {
  return config.key === 'judge' ? 'judge' : 'rule';
}

// ---------------------------------------------------------------------------
// 模板侧（evaluators 表，P1 / PG-07）
// ---------------------------------------------------------------------------

export const EvaluatorTemplate = z.object({
  id: Uuid,
  key: z.string().min(1),
  kind: EvaluatorKind,
  displayName: z.string().min(1),
  description: z.string().nullable(),
  /** 内置算子不可删、不可改 config 语义，只能改展示名与描述。 */
  isBuiltin: z.boolean(),
  version: z.number().int().min(1),
  /** 该模板参数的可编辑字段声明，供 PG-07 表单动态渲染。 */
  configSchema: z.record(z.string(), z.unknown()),
  defaultConfig: EvaluatorConfig,
  createdBy: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type EvaluatorTemplate = z.infer<typeof EvaluatorTemplate>;

export const EvaluatorTemplateCreate = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  /** P1 只允许新建裁判模板；规则算子只能选用内置的六个。 */
  config: JudgeEvaluatorConfig,
});
export type EvaluatorTemplateCreate = z.infer<typeof EvaluatorTemplateCreate>;

export const EvaluatorTemplateUpdate = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  config: JudgeEvaluatorConfig.optional(),
});
export type EvaluatorTemplateUpdate = z.infer<typeof EvaluatorTemplateUpdate>;

// ---------------------------------------------------------------------------
// 实例侧（run_evaluators 表，建 run 时快照，不可变）
// ---------------------------------------------------------------------------

/**
 * 建 run 时提交的算子条目。
 *
 * `weight` 缺省 1，对应 `OPEN-1` 的 `Case 得分 = Σ(score×w)/Σw`。
 * `passThreshold` 缺省 null ⇒ 该算子不参与 `passed` 的 AND 判定，只贡献分数。
 */
export const RunEvaluatorInput = z.object({
  config: EvaluatorConfig,
  weight: z.number().min(0).default(1),
  passThreshold: z.number().min(0).max(1).optional(),
});
export type RunEvaluatorInput = z.infer<typeof RunEvaluatorInput>;

/** 快照行（只读）。`config` 已固化，与模板解耦。 */
export const RunEvaluator = z.object({
  id: Uuid,
  evalRunId: Uuid,
  evaluatorKey: z.string().min(1),
  evaluatorVersion: z.number().int().min(1),
  kind: EvaluatorKind,
  /** 建 run 时的完整参数快照——`PT-1` 可追溯性的物理载体。 */
  config: EvaluatorConfig,
  weight: z.number().min(0),
  passThreshold: z.number().min(0).max(1).nullable(),
  orderIndex: z.number().int().min(0),
});
export type RunEvaluator = z.infer<typeof RunEvaluator>;

// ---------------------------------------------------------------------------
// 单算子评分结果（写入 eval_case_results.operator_scores）
// ---------------------------------------------------------------------------

/**
 * 每个算子的完整结论。
 *
 * `OPEN-2` 明确要求：**不做仲裁，冲突原样呈现**。
 * 因此这里同时保留 `score`（连续分）与 `passed`（布尔），
 * 且 `reason` 必存——它是「规则 0 分 / 裁判 0.9」这类冲突唯一可读的解释来源。
 */
export const OperatorScore = z.object({
  key: z.string().min(1),
  kind: EvaluatorKind,
  /** [0,1]，已按算子自身量表归一化。 */
  score: z.number().min(0).max(1),
  /** null ⇒ 该算子未设阈值，不参与 AND 判定。 */
  passed: z.boolean().nullable(),
  threshold: z.number().min(0).max(1).nullable(),
  weight: z.number().min(0),
  /** 规则算子给结构化差异摘要；裁判算子给模型原始理由。 */
  reason: z.string().nullable(),
});
export type OperatorScore = z.infer<typeof OperatorScore>;

/** `operator_scores` 是 jsonb 数组，落库前用本 schema 逐项校验。 */
export const OperatorScoreList = z.array(OperatorScore);
export type OperatorScoreList = z.infer<typeof OperatorScoreList>;
