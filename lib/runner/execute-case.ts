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
 */
import type {
  CompositeScore,
  DatasetCase,
  EvaluatorConfig,
  OperatorContext,
  OperatorScore,
} from '@eval-platform/contracts';
import { composeCaseScore } from '@eval-platform/contracts';
import type { CaseResultStatus } from '@eval-platform/contracts';
import { chatComplete } from '../gateway/index.js';
import { computeTargetCost, findSnapshotPrice, type PriceSnapshotEntry } from '../cost/index.js';
import { bindByKey } from '../operators/index.js';
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
  readonly latencyMs: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costTarget: number;
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

/**
 * 执行一条 Case。
 *
 * 注意：本函数**不抛业务异常**。任何网关/解析失败都落成 `ExecutedCase.status <> 'OK'`。
 */
export async function executeCase(input: ExecuteCaseInput): Promise<ExecutedCase> {
  const { case: datasetCase } = input;
  const prompt = renderPrompt(input.target.promptTemplate, { case: datasetCase });

  const outcome = await chatComplete({
    baseUrl: input.provider.baseUrl,
    apiKey: input.provider.apiKey,
    model: input.target.modelId,
    messages: [{ role: 'user', content: prompt }],
    temperature: input.target.temperature,
    maxTokens: input.target.maxTokens,
    extraParams: input.target.params ?? undefined,
  });

  const base = {
    caseKey: datasetCase.caseKey,
    datasetCaseId: datasetCase.id,
    retrievalReturned: null,
  } as const;

  if (!outcome.ok) {
    // 失败路径：score 必须为 null（C-3：非 OK ⇒ 无分）
    return {
      ...base,
      status: outcome.status,
      errorMessage: outcome.message,
      outputText: null,
      outputRaw: null,
      score: null,
      passed: null,
      operatorScores: null,
      composite: null,
      latencyMs: outcome.latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      costTarget: 0,
    };
  }

  const outputRaw = { content: outcome.content };
  const ctx = buildContext(datasetCase, outcome.content, outputRaw);

  // 按 order_index（= 数组顺序）串行跑算子；未知 key（如 judge）跳过并记 SKIPPED 理由
  const scores: OperatorScore[] = [];
  for (const spec of input.evaluators) {
    const bound = bindByKey(spec.config.key, spec.config);
    if (!bound) continue;

    const raw = await bound.score(ctx);

    // R-12：runner 回填 passed / threshold
    const passed =
      spec.passThreshold === null ? null : raw.score >= spec.passThreshold;
    scores.push({
      ...raw,
      weight: spec.weight,
      passed,
      threshold: spec.passThreshold,
    });
  }

  const composite = composeCaseScore(scores);

  const price = findSnapshotPrice(
    input.priceSnapshot,
    input.target.modelProviderId,
    input.target.modelId,
  );
  const costTarget = computeTargetCost(price, outcome.tokensIn, outcome.tokensOut);

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
    latencyMs: outcome.latencyMs,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costTarget,
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
