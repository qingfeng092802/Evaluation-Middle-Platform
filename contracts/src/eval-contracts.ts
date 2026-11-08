/**
 * 对外「名字层」+ 算子执行接口 + 双版本 Diff 响应。
 *
 * 本文件解决三类问题，**不新增任何领域事实**：
 *
 *  1. **命名对齐**：需求说明书里的 `EvalProgressEvent` / `RunComparisonDiffResponse`
 *     在这里落地。它们不是新契约，而是既有事实的**别名 / 超集**——
 *     `EvalProgressEvent` ≡ `RunStreamEvent`（`sse.ts`），
 *     `RunComparisonDiffResponse` ⊃ `CompareResponse`（`api.ts`）。
 *     别名而非平行定义：一旦平行定义，两处就会漂移。
 *  2. **SSE 帧结构**：`EvalProgressFrame` 是**线上字节**的形状（`id:` / `event:` / `data:`），
 *     业务载荷在 `data` 里。分离二者的原因见下「关于 `Last-Event-ID`」。
 *  3. **算子实现接口**：`EvaluatorOperator` 是 6 个内置算子唯一的实现契约。
 *     没有它，规则算子与裁判算子会各自演化出不同的返回形状（`TS-3` 短板 2）。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { CaseResultStatus, JsonObject, Score, Uuid } from './common.js';
import { CaseInput, CaseReference, RetrievalAnnotation } from './dataset.js';
import { EvaluatorKind, OperatorScoreList } from './evaluator.js';
import type { OperatorScore } from './evaluator.js';
import type { EvalRun } from './run.js';
import { RunStreamEvent, SSE_EVENT_NAMES } from './sse.js';
import { CompareResponse } from './api.js';

// ---------------------------------------------------------------------------
// 一、SSE 事件帧
// ---------------------------------------------------------------------------

/**
 * 评测进度事件（业务层载荷）。
 *
 * 与 `sse.ts` 的 `RunStreamEvent` **是同一个东西**，此处只提供对外文档中使用的名字。
 * 五类事件：`snapshot` / `case` / `status` / `heartbeat` / `error`。
 *
 * 客户端必须按 `type` 穷尽 `switch`：新增事件类型在编译期即报错，
 * 而不是在线上静默忽略（这是"前端进度条不动"最常见的成因）。
 */
export const EvalProgressEvent = RunStreamEvent;
export type EvalProgressEvent = z.infer<typeof EvalProgressEvent>;

/**
 * SSE 线上帧（一个 `event:` 块）。
 *
 * `id` 是浏览器 `Last-Event-ID` 的取值来源，与业务载荷**分开**存放。
 *
 * ### 关于 `Last-Event-ID`（一处必须显式承认的分歧）
 *
 * 需求方希望「断线重连通过 `Last-Event-ID` 补齐缺失事件」。
 * 已定稿的 `OPEN-4` / `TS-3` 恰恰相反：**v1 不做事件回放**，
 * 重连第一步是拉全量 `snapshot`（快照即真相）。
 *
 * 本契约的取舍：**帧里保留 `id`，但 `PROGRESS_RESUME_POLICY.mode` 仍是 `snapshot_only`。**
 * 理由——
 *  - 有 `id` 才能服务端去重、客户端定位；它是"预留位"，不承诺任何回放能力；
 *  - 真要做回放，代价不在契约，而在环形缓冲区（见 `PROGRESS_RESUME_POLICY` 备注）：
 *    进程重启即丢缓冲，仍要回落到 snapshot。因此回放是"锦上添花"，不是正确性前提。
 *  - 反过来，若先删 `id` 再想加回放，就是一次破坏性协议变更。
 *
 * 该分歧待需求方在「决策点 3」拍板；拍板前不得改写 `mode`。
 */
export const EvalProgressFrame = z.object({
  /** SSE `id:` 字段。约定为「`<runId>:<单调序号>`」。 */
  id: z.string().min(1),
  /**
   * 直接引用 `sse.ts` 的 `SSE_EVENT_NAMES`，不另写一份字面量数组。
   * 两处 enum 一旦分家，就会出现「载荷新增了事件类型、帧的 event 却不认」——
   * 表现为服务端明明发了，客户端 `switch` 落空。
   */
  event: z.enum(SSE_EVENT_NAMES),
  data: EvalProgressEvent,
  /** SSE `retry:` 字段（毫秒）。线上可以完全不出现，故给默认 `null`（沿用浏览器退避）。 */
  retryMs: z.number().int().min(0).nullable().default(null),
});
export type EvalProgressFrame = z.infer<typeof EvalProgressFrame>;

/** `event:` 名与 `data.type` 必须一致 —— 不一致即客户端分派错乱。 */
export function frameMatchesPayload(frame: EvalProgressFrame): boolean {
  return frame.event === frame.data.type;
}

/** `id` 的生成与解析。放在契约里，服务端与测试共用同一段规则。 */
export function encodeStreamEventId(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

export function decodeStreamEventId(id: string): { runId: string; seq: number } | null {
  const sep = id.lastIndexOf(':');
  if (sep <= 0 || sep === id.length - 1) return null;
  const seq = Number(id.slice(sep + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { runId: id.slice(0, sep), seq };
}

/**
 * 进度续传策略（**已拍板定稿，不再变更**）。
 *
 * `mode: 'snapshot_only'` = **不回放事件**，重连先拉 `GET /api/runs/:id` 全量快照。
 * 需求方 2026-11-07 拍板：不加环形缓冲，快照即真相。
 * 若要改成 `'ring_buffer'`，必须同时补三件东西，缺一不可：
 *  1. 环形缓冲的容量上界与淘汰规则（内存不设界 = 跑批越久越危险）；
 *  2. 进程重启后的行为（缓冲在内存里，重启即空，必须回落 snapshot）；
 *  3. `Last-Event-ID` 指向的 seq 已被淘汰时的响应（补 snapshot，而非报错）。
 */
export const PROGRESS_RESUME_POLICY = {
  mode: 'snapshot_only',
  replayImplemented: false,
  /** 开启回放的前置条件；`mode` 变更时必须先满足这三条。 */
  ringBufferPrerequisites: [
    '环形缓冲容量上界与淘汰规则',
    '进程重启后回落 snapshot 的行为',
    'Last-Event-ID 已被淘汰时补发 snapshot',
  ],
  /** 决策留档：已由需求方拍板为 `snapshot_only`（2026-11-07），本条不再是待决项。 */
  decisionRecord: 'RATIFIED: snapshot_only，不做事件回放、不加环形缓冲（需求方 2026-11-07 拍板）',
} as const;

// ---------------------------------------------------------------------------
// 二、算子执行接口
// ---------------------------------------------------------------------------

/**
 * 实际检索上下文（写入 `eval_case_results.retrieval_returned`）。
 *
 * `doc_id` 必须与 `RetrievalRelevantItem.doc_id` **同一套取值**，
 * 否则 Recall@K / MRR / nDCG@K 三个算子会静默算成 0 —— 它们全靠这个键对齐「召回」与「相关」。
 * 其余业务字段走 `catchall` 原样保留，不丢信息。
 */
export const RetrievedContext = z
  .object({
    doc_id: z.string().min(1),
    content: z.string(),
    /** 向量/混合检索的相关度分；规则算子不消费它，仅用于展示与排查。 */
    score: z.number().nullable(),
  })
  .catchall(z.unknown());
export type RetrievedContext = z.infer<typeof RetrievedContext>;

/**
 * 算子的输入上下文（**唯一**允许算子读取的东西）。
 *
 * 刻意做成纯数据 + 无副作用：算子不得访问数据库、不得发网络请求
 * （裁判算子的模型调用由 runner 注入，见 `EvaluatorOperator` 的说明）。
 * 否则 6 个算子会各自长出并发、重试、超时逻辑，`TS-3` 短板 2 就会兑现。
 */
export const OperatorContext = z.object({
  caseKey: z.string().min(1),
  input: CaseInput,
  /** 参考答案；缺失时 `json_schema` / `numeric_fidelity` 仍可运行，裁判算子应报不可评。 */
  reference: CaseReference.nullable(),
  /** 检索标注；`null` ⇒ 三个检索算子必须被判为不可用，而不是算 0 分。 */
  retrievalAnnotation: RetrievalAnnotation.nullable(),
  actualOutput: z.string().nullable(),
  outputRaw: JsonObject.nullable(),
  retrievedContexts: z.array(RetrievedContext).nullable(),
});
export type OperatorContext = z.infer<typeof OperatorContext>;

/**
 * 六个内置算子的统一实现契约。
 *
 * 签名约束（不是风格问题，是正确性问题）：
 *  - `score` **不抛异常**。失败以 `OperatorScore` 之外的方式表达由 runner 负责：
 *    抛错 ⇒ 该 Case 记为 `status='FAILED'` 且 `score=null`，绝不落 0 分。
 *  - `score` 是纯函数（除裁判算子的一次模型调用外）。同样的 `OperatorContext`
 *    必须给同样的分，否则 `OPEN-4`「可解释」就无从解释。
 *  - `requiresRetrieval` 必须与 `EVALUATOR_REQUIRES_RETRIEVAL`（`evaluator.ts`）
 *    的取值一致——两处不一致会让 PG-02 步骤 3 的阻塞校验放行一个注定失败的算子。
 */
export interface EvaluatorOperator {
  readonly key: string;
  readonly kind: EvaluatorKind;
  readonly requiresRetrieval: boolean;
  score(ctx: OperatorContext): Promise<OperatorScore>;
}

// ---------------------------------------------------------------------------
// 三、算子合并口径（OPEN-2：不做仲裁）
// ---------------------------------------------------------------------------

/**
 * 单条 Case 的算子合并结果。
 *
 * `OPEN-2` 定稿：**不做仲裁、冲突原样呈现**。因此这里没有 "winner" 字段，
 * 只有加权均分 + AND 判定 + 一枚冲突标记。
 * `operators` 全量保留，前端可展开看到「规则 0 分 / 裁判 0.9」的原始分歧。
 */
export const CompositeScore = z.object({
  /** 加权均分，已按 `numeric(10,6)` 精度取整；无可计入权重时为 `null`。 */
  score: Score.nullable(),
  /** 所有**有阈值**的算子均通过才是 true；无任何阈值判定时为 `null`。 */
  passed: z.boolean().nullable(),
  operators: OperatorScoreList,
  /** 至少一个算子通过、且至少一个不通过。 */
  hasConflict: z.boolean(),
  /** 冲突时的可读说明（列出分歧的算子 key），无冲突为 `null`。 */
  conflictNote: z.string().nullable(),
});
export type CompositeScore = z.infer<typeof CompositeScore>;

/** 分数落库前统一取整到 `numeric(10,6)`，避免 JS 浮点尾数写进数据库。 */
export function roundScore(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

/**
 * 合并算子结论。
 *
 * 口径（与 `technical-solution.md` `OPEN-2` / `OPEN-3` 一致）：
 *  - 均分按 `weight` 加权，`weight = 0` 的算子只记录不参与；
 *  - `passed` 用 **AND**（任何一个有阈值的算子不通过 ⇒ 整条不通过），
 *    不做多数表决——评测里"一个硬指标挂了"不应被其他高分稀释；
 *  - `hasConflict` 以 `passed` 的分歧为准（一方 true、一方 false），
 *    这是 `OPEN-2` 举例的那种冲突唯一可机器判定的定义。
 */
export function composeCaseScore(operators: OperatorScoreList): CompositeScore {
  const counted = operators.filter((o) => o.weight > 0);

  if (counted.length === 0) {
    return {
      score: null,
      passed: null,
      operators,
      hasConflict: false,
      conflictNote: null,
    };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  for (const o of counted) {
    weightedSum += o.score * o.weight;
    totalWeight += o.weight;
  }

  const verdicts = counted.filter((o) => o.passed !== null);
  const passed = verdicts.length === 0 ? null : verdicts.every((o) => o.passed === true);

  const passKeys = counted.filter((o) => o.passed === true).map((o) => o.key);
  const failKeys = counted.filter((o) => o.passed === false).map((o) => o.key);
  const hasConflict = passKeys.length > 0 && failKeys.length > 0;

  return {
    score: roundScore(weightedSum / totalWeight),
    passed,
    operators,
    hasConflict,
    conflictNote: hasConflict
      ? `算子判定冲突：通过 [${passKeys.join(', ')}] / 不通过 [${failKeys.join(', ')}]`
      : null,
  };
}

// ---------------------------------------------------------------------------
// 四、双版本 AB Diff
// ---------------------------------------------------------------------------

/** 单个算子位的对比结论。 */
export const DiffVerdict = z.enum(['REGRESSED', 'IMPROVED', 'UNCHANGED', 'NOT_COMPARABLE']);
export type DiffVerdict = z.infer<typeof DiffVerdict>;

/**
 * 算子级对比行：同一 `dataset_version_id` 下两个 EvalRun 的该算子均分。
 *
 * `mean` 的分母是**该算子有效计分的 Case 数**，不是总 Case 数——
 * 失败/跳过的 Case 没有分数，计入分母会把"跑挂了"伪装成"分变低了"（`OPEN-5`）。
 */
export const OperatorDiffRow = z.object({
  evaluatorKey: z.string().min(1),
  kind: EvaluatorKind,
  baselineMean: Score.nullable(),
  currentMean: Score.nullable(),
  /** `currentMean - baselineMean`；任一侧为 null 时也是 null。 */
  delta: z.number().nullable(),
  deltaPct: z.number().nullable(),
  baselineScoredCount: z.number().int().min(0),
  currentScoredCount: z.number().int().min(0),
  regressedCount: z.number().int().min(0),
  improvedCount: z.number().int().min(0),
  verdict: DiffVerdict,
});
export type OperatorDiffRow = z.infer<typeof OperatorDiffRow>;

/** 单条 Case 在单个算子上的差值。 */
export const CaseOperatorDiff = z.object({
  evaluatorKey: z.string().min(1),
  kind: EvaluatorKind,
  baselineScore: Score.nullable(),
  currentScore: Score.nullable(),
  delta: z.number().nullable(),
  verdict: DiffVerdict,
});
export type CaseOperatorDiff = z.infer<typeof CaseOperatorDiff>;

/**
 * 逐条对比行（`US-010` / `US-011`）。
 *
 * 是 `api.ts` `CompareCaseRow` 的**超集**：保留原字段（`regressed` / `comparable` /
 * `alignmentWarning`）不动，新增每算子 Δ 与两侧原文，供 Badcase Diff 并排渲染。
 * 对齐键恒为 `case_key`（`ux_dataset_cases_version_key`），
 * 缺键/重复必须走 `alignmentWarning` 显式告警——静默错配比报错危险得多。
 */
export const CaseDiffRow = z.object({
  caseKey: z.string().min(1),
  comparable: z.boolean(),
  alignmentWarning: z.string().nullable(),

  baselineStatus: CaseResultStatus.nullable(),
  currentStatus: CaseResultStatus.nullable(),
  baselineScore: Score.nullable(),
  currentScore: Score.nullable(),
  delta: z.number().nullable(),
  regressed: z.boolean(),
  verdict: DiffVerdict,

  /** 逐算子 Δ；顺序与 `run_evaluators.order_index` 一致。 */
  operators: z.array(CaseOperatorDiff),

  /** 并排 Diff 的两侧原文（PG-04 抽屉）。 */
  baselineOutputText: z.string().nullable(),
  currentOutputText: z.string().nullable(),

  /** 退化行一键下钻到 PG-03 明细所需的最小定位信息。 */
  baselineResultId: Uuid.nullable(),
  currentResultId: Uuid.nullable(),
});
export type CaseDiffRow = z.infer<typeof CaseDiffRow>;

/** 聚合计数。前端顶部四张统计卡直接取这些数，不再自行遍历。 */
export const DiffSummary = z.object({
  totalCases: z.number().int().min(0),
  comparableCases: z.number().int().min(0),
  regressedCases: z.number().int().min(0),
  improvedCases: z.number().int().min(0),
  unchangedCases: z.number().int().min(0),
  notComparableCases: z.number().int().min(0),
});
export type DiffSummary = z.infer<typeof DiffSummary>;

/**
 * 双版本 AB 对比响应（`RunComparisonDiffResponse`）。
 *
 * 由 `CompareResponse` **扩展**而来，不是另写一份：
 * PG-08 页面契约与 AB Diff 共用同一批字段，重复定义必然漂移。
 * 新增的只有「算子级 Δ」`operators`、更厚的 `cases`、聚合 `summary`，
 * 以及回显的 `regressionThreshold`（前端须能显示"本次按阈值 X 判定退化"）。
 *
 * `datasetVersionId` 是**对齐前提**而非普通字段：两个 Run 的
 * `dataset_version_id` 不同时该接口必须拒绝，不能返回一张看似正常的对比表。
 */
export const RunComparisonDiffResponse = CompareResponse.extend({
  datasetVersionId: Uuid,
  operators: z.array(OperatorDiffRow),
  cases: z.array(CaseDiffRow),
  summary: DiffSummary,
  regressionThreshold: z.number().min(0).max(1),
});
export type RunComparisonDiffResponse = z.infer<typeof RunComparisonDiffResponse>;

/**
 * 两个 Run 是否可比的前提校验。
 *
 * 复用 `EvalRun` 已有字段，不额外查询：版本不同即不可比。
 * 返回 `null` 表示可比；返回字符串即前端必须展示的阻断原因。
 */
export function describeIncomparable(baseline: EvalRun, current: EvalRun): string | null {
  if (baseline.datasetVersionId !== current.datasetVersionId) {
    return '两个 EvalRun 的 Dataset Version 不同，逐条对齐无意义（请在同一版本内对比）';
  }
  if (baseline.id === current.id) {
    return '基线 Run 与当前 Run 是同一个任务，无可比性';
  }
  return null;
}

/** 退化判定：两侧都有分且降幅严格大于阈值。缺一侧即 NOT_COMPARABLE，不是 0 分。 */
export function verdictOf(
  baselineScore: number | null,
  currentScore: number | null,
  regressionThreshold: number,
): DiffVerdict {
  if (baselineScore === null || currentScore === null) return 'NOT_COMPARABLE';
  const delta = currentScore - baselineScore;
  if (delta < -regressionThreshold) return 'REGRESSED';
  if (delta > regressionThreshold) return 'IMPROVED';
  return 'UNCHANGED';
}
