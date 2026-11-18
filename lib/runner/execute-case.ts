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
import { chatComplete } from '../gateway/index.js';
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

/** T1 目标执行配置（`resolveTargetExecution` 的 t1 分支，去 kind 后同形）。 */
export interface T1CaseTarget {
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly promptTemplate: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly params: Record<string, unknown> | null;
}

/**
 * 执行目标（M4 Batch 4 起是 union）：T1 平台内执行 / T2 外部 HTTP（US-021）。
 *
 * T2 的映射语义（落地口径，`product-overview.md` §4.1）：
 *  - `requestMapping`：`{ "端点请求体JSON路径": "平台变量" }`——平台变量目前只有
 *    `case.input`（`input.query` 为字符串时取之，否则取整个 input 的 JSON 串）；
 *  - `responseMapping`：`{ "平台字段": "端点响应JSON路径" }`——平台字段白名单
 *    `answer`（必需）/ `retrieval`（可选对象）/ `usage.tokensIn` / `usage.tokensOut` /
 *    `usage.costTarget`（端点自报成本，平台不估算、不乘价）；
 *  - 端点不回 usage ⇒ tokens/cost 记 0，unknown 语义由台账 `unknownCostCases` 暴露。
 */
export type ExecuteTarget =
  | ({ kind: 't1_prompt' } & T1CaseTarget)
  | {
      readonly kind: 't2_http';
      readonly endpointUrl: string;
      readonly authHeaderValue: string | null;
      readonly requestMapping: Record<string, string>;
      readonly responseMapping: Record<string, string>;
    };

export interface ExecuteCaseInput {
  readonly runId: string;
  readonly case: DatasetCase;
  readonly target: ExecuteTarget;
  /**
   * T1 专用：网关指向与 Bearer。T2 目标不经网关 ⇒ `null`
   * （worker 侧 T1 已保证可用，T1 分支内对 null 防御性失败）。
   */
  readonly provider: { readonly baseUrl: string; readonly apiKey: string } | null;
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

/** 目标侧调用产物：T1（网关 chat）与 T2（外部 HTTP）归一后的形状。 */
interface TargetOutcome {
  readonly ok: boolean;
  readonly status: CaseResultStatus;
  readonly message: string | null;
  readonly content: string | null;
  readonly outputRaw: Record<string, unknown> | null;
  readonly retrievalReturned: Record<string, unknown> | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costTarget: number;
  readonly latencyMs: number | null;
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
  readonly retrievalReturned: Record<string, unknown> | null;
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
  message: string | null;
  outcome: { readonly content: string | null } | null;
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

  // ---- 目标侧调用（T1 网关 / T2 外部 HTTP），归一成 TargetOutcome ----
  const target =
    input.target.kind === 't2_http'
      ? await callT2Endpoint(input.target, datasetCase)
      : await callT1Target(input.target, input.provider, input.priceSnapshot, datasetCase);

  const base: BaseShape = {
    caseKey: datasetCase.caseKey,
    datasetCaseId: datasetCase.id,
    retrievalReturned: target.retrievalReturned,
  };

  if (!target.ok) {
    // 目标调用失败：score 必须为 null（C-3：非 OK ⇒ 无分），成本为 0（没有可计量用量）
    return degraded({
      base,
      status: target.status,
      message: target.message,
      outcome: null,
      latencyMs: target.latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      costTarget: 0,
      costJudge: 0,
    });
  }

  const outputRaw = { content: target.content };
  const ctx = buildContext(datasetCase, target.content, outputRaw);
  const costTarget = target.costTarget;

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
          outcome: target,
          latencyMs: target.latencyMs,
          tokensIn: target.tokensIn,
          tokensOut: target.tokensOut,
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
          outcome: target,
          latencyMs: target.latencyMs,
          tokensIn: target.tokensIn,
          tokensOut: target.tokensOut,
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
    outputText: target.content,
    outputRaw,
    score: composite.score,
    passed: composite.passed,
    operatorScores: scores,
    composite,
    judgeReasoning: reasons.length === 0 ? null : reasons.join('\n'),
    latencyMs: target.latencyMs,
    tokensIn: target.tokensIn,
    tokensOut: target.tokensOut,
    costTarget,
    costJudge: computeJudgeCost(judgeConfig, input.priceSnapshot, judgeTokensIn, judgeTokensOut),
  };
}

// ---------------------------------------------------------------------------
// 目标侧调用（T1 网关 / T2 外部 HTTP）
// ---------------------------------------------------------------------------

/** T1：平台内网关调用（`chatComplete`），成本按快照单价 × token（TS-2 红线）。 */
async function callT1Target(
  target: T1CaseTarget,
  provider: { readonly baseUrl: string; readonly apiKey: string } | null,
  priceSnapshot: readonly PriceSnapshotEntry[],
  datasetCase: DatasetCase,
): Promise<TargetOutcome> {
  if (!provider) {
    return {
      ok: false,
      status: 'FAILED',
      message: 'T1 目标缺少可用厂商（worker 前置校验被绕过？）',
      content: null,
      outputRaw: null,
      retrievalReturned: null,
      tokensIn: 0,
      tokensOut: 0,
      costTarget: 0,
      latencyMs: null,
    };
  }
  const prompt = renderPrompt(target.promptTemplate, { case: datasetCase });
  const outcome = await chatComplete({
    // 「发给谁 / 带哪个 Bearer」由 target 决定：直连厂商，或经 LiteLLM sidecar。
    // 关键点是两者必须同时切换——只换地址不换 Key 会在 sidecar 侧得到 401。
    ...chatTargetFromEnv(provider),
    model: target.modelId,
    messages: [{ role: 'user', content: prompt }],
    temperature: target.temperature,
    maxTokens: target.maxTokens,
    extraParams: target.params ?? undefined,
  });
  if (!outcome.ok) {
    return {
      ok: false,
      status: outcome.status,
      message: outcome.message,
      content: null,
      outputRaw: null,
      retrievalReturned: null,
      tokensIn: 0,
      tokensOut: 0,
      costTarget: 0,
      latencyMs: outcome.latencyMs,
    };
  }
  return {
    ok: true,
    status: 'OK',
    message: null,
    content: outcome.content,
    outputRaw: { content: outcome.content },
    retrievalReturned: null,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costTarget: computeTargetCost(
      findSnapshotPrice(priceSnapshot, target.modelProviderId, target.modelId),
      outcome.tokensIn,
      outcome.tokensOut,
    ),
    latencyMs: outcome.latencyMs,
  };
}

// ---- T2 映射原语（点路径 + 数字索引，如 `messages.0.content`）----

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (typeof next !== 'object' || next === null) {
      cur[seg] = /^\d+$/.test(segs[i + 1] ?? '') ? [] : {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

function numberOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * 平台变量解析。目前只有 `case.input`：`input.query` 为字符串时取之
 * （与导入侧 `{"query": …}` 形状对齐），否则整个 input 的 JSON 串。
 */
function resolveCaseVariable(name: string, c: DatasetCase): string {
  if (name === 'case.input') {
    if (typeof c.input === 'string') return c.input;
    const q = (c.input as Record<string, unknown> | undefined)?.['query'];
    if (typeof q === 'string') return q;
    return JSON.stringify(c.input);
  }
  throw new Error(`未知的平台变量 "${name}"（目前只支持 case.input）`);
}

/** T2：外部 HTTP 调用（US-021）。任何失败都落成 TargetOutcome，不抛业务异常。 */
async function callT2Endpoint(
  t: { endpointUrl: string; authHeaderValue: string | null; requestMapping: Record<string, string>; responseMapping: Record<string, string> },
  datasetCase: DatasetCase,
): Promise<TargetOutcome> {
  const started = Date.now();
  const zero = {
    content: null,
    outputRaw: null,
    retrievalReturned: null,
    tokensIn: 0,
    tokensOut: 0,
    costTarget: 0,
  };
  try {
    const payload: Record<string, unknown> = {};
    for (const [path, variable] of Object.entries(t.requestMapping)) {
      setPath(payload, path, resolveCaseVariable(variable, datasetCase));
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // 鉴权 Header 名固定 Authorization，值是配置时的完整值（如 `Bearer xxx`）；
    // 明文只存在于这一次请求里，任何落库/响应/日志都不回显（US-021）。
    if (t.authHeaderValue !== null) headers['authorization'] = t.authHeaderValue;

    const res = await fetch(t.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        status: 'FAILED',
        message: `T2 端点返回 HTTP ${res.status}`,
        ...zero,
        latencyMs,
      };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, status: 'PARSE_ERROR', message: 'T2 端点响应不是合法 JSON', ...zero, latencyMs };
    }

    const answerPath = t.responseMapping['answer'];
    if (answerPath === undefined) {
      return { ok: false, status: 'PARSE_ERROR', message: 'responseMapping 未映射 answer 字段', ...zero, latencyMs };
    }
    const answer = getPath(json, answerPath);
    if (typeof answer !== 'string') {
      return {
        ok: false,
        status: 'PARSE_ERROR',
        message: `answer 路径 "${answerPath}" 在端点响应中缺失或非字符串`,
        ...zero,
        latencyMs,
      };
    }

    const retrievalRaw = t.responseMapping['retrieval'] !== undefined ? getPath(json, t.responseMapping['retrieval']) : undefined;
    return {
      ok: true,
      status: 'OK',
      message: null,
      content: answer,
      outputRaw: { content: answer },
      retrievalReturned:
        retrievalRaw !== null && retrievalRaw !== undefined && typeof retrievalRaw === 'object'
          ? (retrievalRaw as Record<string, unknown>)
          : null,
      // 端点不回 usage ⇒ 0（unknown 语义由台账 unknownCostCases 暴露，不估算）
      tokensIn: numberOf(getPath(json, t.responseMapping['usage.tokensIn'] ?? '')) ?? 0,
      tokensOut: numberOf(getPath(json, t.responseMapping['usage.tokensOut'] ?? '')) ?? 0,
      // 成本由端点自报（product-overview §4.1）：平台不估算、不乘价
      costTarget: numberOf(getPath(json, t.responseMapping['usage.costTarget'] ?? '')) ?? 0,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'FAILED',
      message: `T2 端点调用失败：${(err as Error).message}`,
      ...zero,
      latencyMs: Date.now() - started,
    };
  }
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
