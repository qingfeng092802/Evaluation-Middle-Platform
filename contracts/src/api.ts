/**
 * REST 请求 / 响应体（按页面组织）。
 *
 * 事实源：`docs/facts/pages-and-flows.md` PG-01…PG-10。
 *
 * 本文件**只定义传输形状**，不包含业务实现。每个分组都标注它所服务的页面编号，
 * 便于「页面 ↔ 契约」双向追溯（`工程规则` §1 单一事实源）。
 *
 * 统一约定：
 *  - 列表响应 `{ items, nextCursor, total? }`；
 *  - 错误响应 `{ error: ApiError }`；
 *  - 所有写入接口均为幂等键友好（`POST /api/runs` 建 EvalRun 为例外：重复提交会产生新 run）。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import {
  CaseResultStatus,
  IsoDateTime,
  PageMeta,
  PageQuery,
  RunStatus,
  Score,
  Uuid,
} from './common.js';
import {
  Dataset,
  DatasetCase,
  DatasetCreate,
  DatasetUpdate,
  DatasetVersion,
  DatasetVersionCreate,
  DatasetVersionDetail,
  ImportValidationReport,
  RetrievalReadiness,
} from './dataset.js';
import {
  Baseline,
  BaselineDecision,
  BaselineNominate,
  BaselineResolution,
  GateResultEnvelope,
  RegressionGate,
  RegressionGateCreate,
  RegressionGateUpdate,
} from './gate.js';
import {
  EvaluatorConfig,
  EvaluatorTemplate,
  EvaluatorTemplateCreate,
  EvaluatorTemplateUpdate,
  RunEvaluatorInput,
} from './evaluator.js';
import {
  ModelPrice,
  ModelPriceCreate,
  ModelProvider,
  ModelProviderCreate,
  ModelProviderUpdate,
  CostLedgerRow,
  CostLedgerSummary,
} from './provider.js';
import {
  EvalCaseResult,
  EvalRun,
  EvalRunCancel,
  EvalRunCreate,
  EvalRunDetail,
} from './run.js';
import { Target, TargetCreate, TargetUpdate, TargetVersion } from './target.js';

// ---------------------------------------------------------------------------
// 通用列表包装（各实体具体化，避免泛型在 Zod v3/v4 间的签名差异）
// ---------------------------------------------------------------------------

export const DatasetListQuery = PageQuery.extend({
  keyword: z.string().optional(),
});
export const DatasetListResponse = z.object({
  items: z.array(Dataset),
  page: PageMeta,
});

export const DatasetVersionListResponse = z.object({
  items: z.array(DatasetVersion),
  page: PageMeta,
});

export const DatasetCaseListResponse = z.object({
  items: z.array(DatasetCase),
  page: PageMeta,
});

export const TargetListResponse = z.object({
  items: z.array(Target),
  page: PageMeta,
});

export const TargetVersionListResponse = z.object({
  items: z.array(TargetVersion),
  page: PageMeta,
});

export const EvalRunListQuery = PageQuery.extend({
  status: RunStatus.optional(),
  datasetId: Uuid.optional(),
  targetId: Uuid.optional(),
});
export const EvalRunListResponse = z.object({
  items: z.array(EvalRun),
  page: PageMeta,
});

export const EvalCaseResultListQuery = PageQuery.extend({
  /** PG-03 工具栏：P0 仅支持按得分排序。 */
  sortBy: z.enum(['score', 'latency', 'caseKey']).default('score'),
  order: z.enum(['asc', 'desc']).default('asc'),
  /** P1 筛选条件，P0 期恒为 undefined。 */
  minScore: z.number().min(0).max(1).optional(),
  maxScore: z.number().min(0).max(1).optional(),
  status: CaseResultStatus.optional(),
  evaluatorKey: z.string().optional(),
  regressedOnly: z.boolean().optional(),
});
export const EvalCaseResultListResponse = z.object({
  items: z.array(EvalCaseResult),
  page: PageMeta,
});

export const EvaluatorTemplateListResponse = z.object({
  items: z.array(EvaluatorTemplate),
  page: PageMeta,
});

export const ModelProviderListResponse = z.object({
  items: z.array(ModelProvider),
  page: PageMeta,
});

export const ModelPriceListResponse = z.object({
  items: z.array(ModelPrice),
  page: PageMeta,
});

export const RegressionGateListResponse = z.object({
  items: z.array(RegressionGate),
  page: PageMeta,
});

export const BaselineListResponse = z.object({
  items: z.array(Baseline),
  page: PageMeta,
});

export const CostLedgerResponse = z.object({
  summary: CostLedgerSummary,
  items: z.array(CostLedgerRow),
  page: PageMeta,
});

// ---------------------------------------------------------------------------
// PG-01 / PG-02 / PG-03 · 运行
// ---------------------------------------------------------------------------

/** PG-01 前置依赖横幅（`US-015`）：凭证未配置时禁止发起评测。 */
export const RunPreflight = z.object({
  hasProviderCredentials: z.boolean(),
  hasEvaluators: z.boolean(),
  /** 供 PG-02 步骤 3 使用；为 'NONE' 时三个检索算子必须禁用。 */
  retrievalReadiness: RetrievalReadiness,
  /** 逐条阻塞原因，与 PG-02 的三条文案一一对应。 */
  blockers: z.array(
    z.enum([
      'BLOCKED_NO_PROVIDER_CREDENTIALS',
      'BLOCKED_NO_EVALUATORS',
      'BLOCKED_NO_RETRIEVAL_ANNOTATION',
    ]),
  ),
  /** 全部通过才允许点「启动评测」。 */
  canStart: z.boolean(),
});
export type RunPreflight = z.infer<typeof RunPreflight>;

export const RunPreflightQuery = z.object({
  datasetVersionId: Uuid,
  /** 已选算子，用于判定「选了检索算子但无标注」。 */
  evaluatorKeys: z.array(z.string()).optional(),
});

/** PG-03 明细行下钻（`US-011`，PG-04 抽屉）。 */
export const CaseDetailResponse = z.object({
  result: EvalCaseResult,
  /** 输入 / 参考答案 / 检索标注来自所属 Dataset Version（只读）。 */
  datasetCase: DatasetCase,
  /** PG-04 区块 3 降级规则的机器可读依据。 */
  hasBaseline: z.boolean(),
  /** 双栏 Diff 的基线侧结果；无基线时为 null。 */
  baselineResult: EvalCaseResult.nullable(),
});
export type CaseDetailResponse = z.infer<typeof CaseDetailResponse>;

// ---------------------------------------------------------------------------
// PG-05 · 评测集
// ---------------------------------------------------------------------------

export const DatasetImportValidate = z.object({
  /** 原始文件内容（JSONL 或 CSV 文本）。解析与校验在服务端完成，避免双份实现。 */
  content: z.string().min(1),
  format: z.enum(['jsonl', 'csv']),
});
export type DatasetImportValidate = z.infer<typeof DatasetImportValidate>;

// ---------------------------------------------------------------------------
// PG-08 · 报告对比
// ---------------------------------------------------------------------------

/**
 * 汇总对比单行。
 *
 * `delta` 为绝对差（current - baseline），`deltaPct` 为相对差；
 * 二者都给：绝对差有意义（0.82→0.91 = +0.09），
 * 相对差也有意义（+11%），让前端不必自己算哪个。
 */
export const CompareMetricRow = z.object({
  metric: z.enum([
    'score_overall',
    'pass_rate',
    'coverage',
    'latency_p50_ms',
    'latency_p95_ms',
    'cost_total',
  ]),
  label: z.string(),
  baseline: z.number().nullable(),
  current: z.number().nullable(),
  delta: z.number().nullable(),
  deltaPct: z.number().nullable(),
  /** 该指标「变大是好是坏」，供前端着色（耗时/成本升为红）。 */
  higherIsBetter: z.boolean(),
});
export type CompareMetricRow = z.infer<typeof CompareMetricRow>;

/** 逐条对比单行（`US-010` / `US-011`）。 */
export const CompareCaseRow = z.object({
  caseKey: z.string(),
  baselineScore: Score.nullable(),
  currentScore: Score.nullable(),
  delta: z.number().nullable(),
  /** 退化 = 当前分低于基线分且超出阈值。 */
  regressed: z.boolean(),
  /** 任一侧缺失（v1/v2 未对齐）时为 false，用于渲染「无法对比」而非「0 分」。 */
  comparable: z.boolean(),
  /**
   * 数据可能存在的对齐问题（case_key 缺失/重复）。
   * 一旦非空，前端必须在表头显示警告——静默错配比报错危险得多。
   */
  alignmentWarning: z.string().nullable(),
});
export type CompareCaseRow = z.infer<typeof CompareCaseRow>;

export const CompareQuery = z.object({
  baselineRunId: Uuid,
  currentRunId: Uuid,
  /** 逐条对比的退化阈值，默认 0（任何下降都算退化）。 */
  regressionThreshold: z.number().min(0).max(1).default(0),
});

export const CompareResponse = z.object({
  baselineRun: EvalRun,
  currentRun: EvalRun,
  metrics: z.array(CompareMetricRow),
  cases: z.array(CompareCaseRow),
  page: PageMeta,
  /**
   * `BL-2`：门禁的「退化超 N%」永远相对**已确认 baseline**。
   * 本次对比若未使用已确认基线，此横幅必须显示。
   */
  baselineConfirmed: z.boolean(),
  banner: z.string().nullable(),
});
export type CompareResponse = z.infer<typeof CompareResponse>;

// ---------------------------------------------------------------------------
// PG-09 / PG-10 · 管理配置与台账
// ---------------------------------------------------------------------------

/** PG-09「推送渠道」生成回调 Token 的响应。Token 明文只返回这一次。 */
export const CallbackTokenResponse = z.object({
  token: z.string(),
  /** 明文仅此一次可见，之后只能重置。 */
  expiresAt: IsoDateTime.nullable(),
});
export type CallbackTokenResponse = z.infer<typeof CallbackTokenResponse>;

/** 门禁结果查询（CI 侧拉取，`US-018` 实现边界）。 */
export const GateResultResponse = z.object({ gateResult: GateResultEnvelope });

// ---------------------------------------------------------------------------
// 契约自检用：把「写侧」与「读侧」的形状差异集中声明
// ---------------------------------------------------------------------------

/**
 * 写读非对称清单。
 *
 * 这张表是给代码评审与安全审查用的：任何新增字段若同时出现在两侧，
 * 就应该问一句"它是不是不该被读出来"。
 */
export const WRITE_ONLY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ModelProviderCreate: ['apiKey'],
  TargetVersionConfig_t2_http: ['authHeader'],
} as const;

/**
 * 供各 API 路由复用的请求体类型别名。
 * 集中在一处声明，避免各路由各自 `z.infer` 出细微不同的类型。
 */
export type DatasetCreateBody = z.infer<typeof DatasetCreate>;
export type DatasetUpdateBody = z.infer<typeof DatasetUpdate>;
export type DatasetVersionCreateBody = z.infer<typeof DatasetVersionCreate>;
export type DatasetImportValidateBody = z.infer<typeof DatasetImportValidate>;
export type DatasetVersionDetailView = z.infer<typeof DatasetVersionDetail>;
export type ImportValidationReportView = z.infer<typeof ImportValidationReport>;

export type TargetCreateBody = z.infer<typeof TargetCreate>;
export type TargetUpdateBody = z.infer<typeof TargetUpdate>;

export type EvalRunCreateBody = z.infer<typeof EvalRunCreate>;
export type EvalRunCancelBody = z.infer<typeof EvalRunCancel>;
export type EvalRunDetailView = z.infer<typeof EvalRunDetail>;
export type RunEvaluatorInputBody = z.infer<typeof RunEvaluatorInput>;
export type EvaluatorConfigBody = z.infer<typeof EvaluatorConfig>;

export type EvaluatorTemplateCreateBody = z.infer<typeof EvaluatorTemplateCreate>;
export type EvaluatorTemplateUpdateBody = z.infer<typeof EvaluatorTemplateUpdate>;

export type ModelProviderCreateBody = z.infer<typeof ModelProviderCreate>;
export type ModelProviderUpdateBody = z.infer<typeof ModelProviderUpdate>;
export type ModelPriceCreateBody = z.infer<typeof ModelPriceCreate>;

export type RegressionGateCreateBody = z.infer<typeof RegressionGateCreate>;
export type RegressionGateUpdateBody = z.infer<typeof RegressionGateUpdate>;
export type BaselineNominateBody = z.infer<typeof BaselineNominate>;
export type BaselineDecisionBody = z.infer<typeof BaselineDecision>;
export type BaselineResolutionView = z.infer<typeof BaselineResolution>;
