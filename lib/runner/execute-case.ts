/**
 * 单条 Case 的执行单元（runner）。
 *
 * 职责边界（SPEC-M1 D-6b / R-12，锁定）：
 *  - **算子只产 `score` + `reason`**（`passed: null, threshold: null`）；
 *  - **本文件回填 `passed` / `threshold`**：`passThreshold == null` ⇒ `passed = null`；
 *    否则 `passed = score >= passThreshold`，`threshold` 记该值。
 *
 * 把回填放在这里而不是算子里的理由：阈值属于**运行实例**（`run_evaluators.pass_threshold`），
 * 同一份算子配置在不同 run 里阈值可以不同。若让算子自己判，`composeCaseScore` 的 AND
 * 语义就会被两处逻辑争夺。
 *
 * 失败语义：网关失败 ⇒ 该 Case `status<>OK` 且 `score=null`。**绝不组装成 0 分。**
 *
 * ## 裁判算子（M2 · Batch 2）
 *
 * 裁判的那一次模型调用由本文件**注入**（算子本身必须纯，见 `lib/operators/judge.ts`）。
 * 注入点做成 `resolveJudgeChat` 而不是直接 import `judge-chat.ts`：
 *  - 保持本文件的依赖是「形状」而非「实现」，测试可以塞假 chat；
 *  - 「裁判模型不可用」在**取 chat 时**就能判定（返回 `null`），
 *    不必伪造一个必然失败的请求。
 *
 * 裁判失败（解析 / 网关 / 无厂商）⇒ 整条 Case 降级：`score=null`，且**已算出的部分
 * 算子分一并丢弃** —— 半张成绩单比没有成绩单更容易被误读（`OPEN-5`）。
 * 但**目标侧输出与两侧成本保留**：钱花了、模型答了，这些是事实，
 * 「评分失败」不该把已经发生的开销从账上抹掉。
 */
import type {
  CompositeScore,
  DatasetCase,
  EvaluatorConfig,
  JudgeEvaluatorConfig,
  OperatorContext,
  OperatorScore,
} from '@eval-platform/contracts';
import { composeCaseScore } from '@eval-platform/contracts';
import type { CaseResultStatus } from '@eval-platform/contracts';
import { chatComplete, type ChatSuccess } from '../gateway/index.js';
import { chatTargetFromEnv } from '../gateway/target.js';
import { computeTargetCost, findSnapshotPrice, type PriceSnapshotEntry } from '../cost/index.js';
import { bindOperator } from '../operators/shared.js';
import { bindByKey } from '../operators/index.js';
import { createJudgeOperator, JudgeError, type JudgeChat } from '../operators/judge.js';
import { renderPrompt } from './prompt.js';
import type { NormalizedCase } from '../import/canonical.js';

export interface RunEvaluatorSpec {
  readonly evaluatorKey: string;
  readonly kind: 'rule' | 'judge';
  readonly config: EvaluatorConfig;
  readonly weight: number;
  readonly passThreshold: number | null;
}

export interface ExecuteCaseInput {
  readonly runId: string;
  readonly case: DatasetCase;
  readonly target: {
    readonly modelProviderId: string;
    readonly modelId: string;
    readonly promptTemplate: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly params: Record<string, unknown> | null;
  };
  readonly provider: { readonly baseUrl: string; readonly apiKey: string };
  readonly evaluators: readonly RunEvaluatorSpec[];
  readonly priceSnapshot: readonly PriceSnapshotEntry[];
  /**
   * 按裁判配置造一次模型调用。
   *
   * 返回 `null` = **该裁判模型不可用**（厂商停用 / 无 base_url / 无凭据）。
   * 这种情况必须显式失败而不是「跳过裁判，用剩下的算子凑个分」——
   * 那会让「裁判没跑」伪装成「裁判没意见」。
   */
  readonly resolveJudgeChat: (config: JudgeEvaluatorConfig) => JudgeChat | null;
  readonly caseKeyFallback?: string | undefined;
}

export interface ExecutedCase {
  readonly caseKey: string;
  readonly datasetCaseId: string;
  readonly status: CaseResultStatus;
  readonly errorMessage: string | null;
  readonly outputText: string | null;
  readonly outputRaw: Record<string, unknown> | null;
  readonly retrievalReturned: Record<string, unknown> | null;
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly operatorScores: OperatorScore[] | null;
  readonly composite: CompositeScore | null;
  /** 裁判给出的理由（多条按执行顺序换行拼接）；无裁判算子、或裁判未产理由时为 `null`。 */
  readonly judgeReasoning: string | null;
  readonly latencyMs: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costTarget: number;
  readonly costJudge: number;
}

/** 把 `DatasetCase` 转成算子上下文；`actualOutput` 在成功路径上才填。 */
function buildContext(
  c: DatasetCase,
  actualOutput: string | null,
  outputRaw: Record<string, unknown> | null,
): OperatorContext {
  return {
    caseKey: c.caseKey,
    input: c.input as OperatorContext['input'],
    reference: c.reference ?? null,
    retrievalAnnotation: c.retrieval ?? null,
    actualOutput,
    outputRaw,
    retrievedContexts: null,
  };
}

/** R-12：runner 回填 `passed` / `threshold`（契约要求算子自己只填 score/reason）。 */
function withThreshold(raw: OperatorScore, spec: RunEvaluatorSpec): OperatorScore {
  return {
    ...raw,
    weight: spec.weight,
    passed: spec.passThreshold === null ? null : raw.score >= spec.passThreshold,
    threshold: spec.passThreshold,
  };
}

/**
 * 包一层，把裁判调用实际消耗的 token 收上来。
 *
 * 为什么必须收：裁判成本要单独入账（`OPEN-3` 的 `cost_judge`），而成本只能由
 * `model_prices` 单价 × token 算出（`TS-2` 红线）。**解析失败时调用也已经发生**，
 * 钱已经花了，token 必须照记。
 */
function meterJudgeChat(chat: JudgeChat): {
  chat: JudgeChat;
  usage: () => { tokensIn: number; tokensOut: number };
} {
  let tokensIn = 0;
  let tokensOut = 0;
  return {
    chat: async (req) => {
      const outcome = await chat(req);
      if (outcome.ok) {
        tokensIn += outcome.tokensIn;
        tokensOut += outcome.tokensOut;
      }
      return outcome;
    },
    usage: () => ({ tokensIn, tokensOut }),
  };
}

/**
 * 裁判成本 = 裁判模型快照单价 × 裁判 token。
 *
 * 单价按裁判自己的 `(modelProviderId, modelId)` 从快照里找 —— **绝不借目标模型的价**。
 * 找不到单价记 0（与 `computeTargetCost` 同一口径：没配价不等于报错），
 * 但也不会退化成用别人的价凑一个数。
 */
function computeJudgeCost(
  config: EvaluatorConfig | undefined,
  snapshot: readonly PriceSnapshotEntry[],
  tokensIn: number,
  tokensOut: number,
): number {
  if (config === undefined || config.key !== 'judge') return 0;
  return computeTargetCost(
    findSnapshotPrice(snapshot, config.modelProviderId, config.modelId),
    tokensIn,
    tokensOut,
  );
}

interface BaseShape {
  readonly caseKey: string;
  readonly datasetCaseId: string;
  readonly retrievalReturned: null;
}

/**
 * 降级构造：整条 Case 无分（`score=null` / `passed=null` / `operatorScores=null`）。
 *
 * 所有失败路径都走这里，保证「失败 ⇒ 无分」只有一处实现：
 * 一旦有人只在一两个分支里手写 `score: null`，剩下那条迟早会漏成 0 分。
 */
function degraded(p: {
  base: BaseShape;
  status: CaseResultStatus;
  message: string;
  outcome: ChatSuccess | null;
  latencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costTarget: number;
  costJudge: number;
}): ExecutedCase {
  return {
    ...p.base,
    status: p.status,
    errorMessage: p.message,
    outputText: p.outcome?.content ?? null,
    outputRaw: p.outcome === null ? null : { content: p.outcome.content },
    score: null,
    passed: null,
    operatorScores: null,
    composite: null,
    judgeReasoning: null,
    latencyMs: p.latencyMs,
    tokensIn: p.tokensIn,
    tokensOut: p.tokensOut,
    costTarget: p.costTarget,
    costJudge: p.costJudge,
  };
}

/**
 * 执行一条 Case。
 *
 * 注意：本函数**不抛业务异常**。任何网关/解析失败都落成 `ExecutedCase.status <> 'OK'`。
 */
export async function executeCase(input: ExecuteCaseInput): Promise<ExecutedCase> {
  const { case: datasetCase } = input;
  const prompt = renderPrompt(input.target.promptTemplate, { case: datasetCase });

  const outcome = await chatComplete({
    // 「发给谁 / 带哪个 Bearer」由 target 决定：直连厂商，或经 LiteLLM sidecar。
    // 关键点是两者必须同时切换——只换地址不换 Key 会在 sidecar 侧得到 401。
    ...chatTargetFromEnv(input.provider),
    model: input.target.modelId,
    messages: [{ role: 'user', content: prompt }],
    temperature: input.target.temperature,
    maxTokens: input.target.maxTokens,
    extraParams: input.target.params ?? undefined,
  });

  const base: BaseShape = {
    caseKey: datasetCase.caseKey,
    datasetCaseId: datasetCase.id,
    retrievalReturned: null,
  };

  if (!outcome.ok) {
    // 目标模型调用失败：score 必须为 null（C-3：非 OK ⇒ 无分），成本为 0（根本没有用量）
    return degraded({
      base,
      status: outcome.status,
      message: outcome.message,
      outcome: null,
      latencyMs: outcome.latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      costTarget: 0,
      costJudge: 0,
    });
  }

  const outputRaw = { content: outcome.content };
  const ctx = buildContext(datasetCase, outcome.content, outputRaw);

  const costTarget = computeTargetCost(
    findSnapshotPrice(input.priceSnapshot, input.target.modelProviderId, input.target.modelId),
    outcome.tokensIn,
    outcome.tokensOut,
  );

  // 按 order_index（= 数组顺序）串行跑算子
  const scores: OperatorScore[] = [];
  const reasons: string[] = [];
  let judgeTokensIn = 0;
  let judgeTokensOut = 0;

  for (const spec of input.evaluators) {
    if (spec.kind === 'judge') {
      const judgeConfig = spec.config as JudgeEvaluatorConfig;
      const chat = input.resolveJudgeChat(judgeConfig);
      if (chat === null) {
        // 裁判模型不可用 ⇒ 整条 Case 失败。**不跳过**：跳过会伪装成「裁判没意见」。
        return degraded({
          base,
          status: 'FAILED',
          message: `裁判模型不可用（${judgeConfig.modelId}）：未找到启用的厂商或缺少 baseUrl`,
          outcome,
          latencyMs: outcome.latencyMs,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          costTarget,
          costJudge: 0,
        });
      }

      const meter = meterJudgeChat(chat);
      const bound = bindOperator(createJudgeOperator({ chat: meter.chat }), judgeConfig);
      try {
        const raw = await bound.score(ctx);
        scores.push(withThreshold(raw, spec));
        if (raw.reason !== null) reasons.push(raw.reason);
      } catch (err) {
        // 降级信号只能走控制流：`OperatorScore.score` 表达不了 null（见 judge.ts 文件头）
        if (!(err instanceof JudgeError)) throw err;
        const used = meter.usage();
        return degraded({
          base,
          status: err.status,
          message: err.message,
          outcome,
          latencyMs: outcome.latencyMs,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          costTarget,
          // 失败前若已真的调过模型，这笔钱照样入账
          costJudge: computeJudgeCost(judgeConfig, input.priceSnapshot, used.tokensIn, used.tokensOut),
        });
      } finally {
        const used = meter.usage();
        judgeTokensIn += used.tokensIn;
        judgeTokensOut += used.tokensOut;
      }
      continue;
    }

    // ---- 规则算子 ----
    const bound = bindByKey(spec.config.key, spec.config);
    if (!bound) continue;
    scores.push(withThreshold(await bound.score(ctx), spec));
  }

  const judgeConfig = input.evaluators.find((e) => e.kind === 'judge')?.config;
  const composite = composeCaseScore(scores);

  return {
    ...base,
    status: 'OK',
    errorMessage: null,
    outputText: outcome.content,
    outputRaw,
    score: composite.score,
    passed: composite.passed,
    operatorScores: scores,
    composite,
    judgeReasoning: reasons.length === 0 ? null : reasons.join('\n'),
    latencyMs: outcome.latencyMs,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costTarget,
    costJudge: computeJudgeCost(judgeConfig, input.priceSnapshot, judgeTokensIn, judgeTokensOut),
  };
}

/** 供 worker 用：把 `NormalizedCase` 之外的依赖整理成一组参数。 */
export function specFromRunEvaluator(e: {
  evaluatorKey: string;
  kind: 'rule' | 'judge';
  config: unknown;
  weight: number;
  passThreshold: number | null;
}): RunEvaluatorSpec {
  return {
    evaluatorKey: e.evaluatorKey,
    kind: e.kind,
    config: e.config as EvaluatorConfig,
    weight: e.weight,
    passThreshold: e.passThreshold,
  };
}

export type { NormalizedCase };
