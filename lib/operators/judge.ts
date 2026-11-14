/**
 * LLM-as-a-Judge 算子（`[BE-M2-04]`，Batch 2 交付物 4）。
 *
 * ## 为什么是工厂而不是单例
 *
 * `eval-contracts.ts` 的 `OperatorContext` 注释与 `lib/operators/index.ts` 的模块注释
 * 写死了一条边界：**算子不得访问数据库、不得自己发网络请求**，否则六个算子会各自
 * 长出并发 / 重试 / 超时逻辑（`TS-3` 短板 2）。裁判算子必须调一次模型，
 * 因此这一次调用由外部**注入**：生产环境由 runner 注入基于 `lib/gateway` 的实现，
 * 测试注入假实现。契约 `EvaluatorOperator` 不变（SPEC-M1 C-1）。
 *
 * ## 为什么解析失败要「抛」而不是「返回 0 分」
 *
 * 准出条件原文：非法 JSON ⇒ `PARSE_ERROR` + `score IS NULL`，**不落 0 分**。
 * 而 `OperatorScore.score` 在契约里是 `min(0)` 的 number，**表达不了 null**。
 * 所以降级信号只能走控制流：抛 `JudgeError`，由 runner 把整条 Case 记成
 * `status = err.status`、`score = null`、`error_message = err.message`。
 *
 * 静默 clamp 与静默补 0 都被刻意排除：
 *  - 超量表（`scaleMax=5` 却给 9）⇒ 判为 `PARSE_ERROR`，不 clamp 成 1.0 ——
 *    否则「裁判没按量表打分」这个事实会被掩盖；
 *  - 模型输出为空 ⇒ 抛错而不是当成 0 分 —— 「没答」与「答错」是两件事。
 */
import type {
  CaseResultStatus,
  JudgeEvaluatorConfig,
  OperatorContext,
  OperatorScore,
} from '@eval-platform/contracts';
import { type ConfigurableOperator } from './shared.js';
import { safeScore } from './shared.js';
import { extractJsonText } from './json-schema.js';

/**
 * 一条对话消息。
 *
 * 刻意不安在 `src/contracts/`：裁判的模型调用是**进程内**的实现细节，
 * 不是对外契约的一部分，把它搬进契约层会让「契约只描述 API 形状」这条边界失守。
 */
export interface JudgeMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** 注入的模型调用入参（不含 provider / model —— 由注入方闭包固定）。 */
export interface JudgeChatRequest {
  readonly messages: readonly JudgeMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
}

export interface JudgeChatSuccess {
  readonly ok: true;
  readonly content: string;
  /**
   * 本次裁判调用消耗的 token。
   *
   * 必须由注入方回报：裁判成本要**单独入账**（`OPEN-3` 的 `cost_judge`），
   * 而成本只能由 `model_prices` 单价 × token 算出（`TS-2` 红线）。
   * 算子本身只把它原样带出去，不解释账目。
   */
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface JudgeChatFailure {
  readonly ok: false;
  readonly status: CaseResultStatus;
  readonly message: string;
}

export type JudgeChatOutcome = JudgeChatSuccess | JudgeChatFailure;

/** 裁判模型的一次调用。由 runner 注入；实现见 `lib/runner/judge-chat.ts`。 */
export type JudgeChat = (req: JudgeChatRequest) => Promise<JudgeChatOutcome>;

/**
 * 裁判不可评 / 不可信时抛出。
 *
 * `status` 直接沿用契约的 `CaseResultStatus`，runner 据此写 `eval_case_results.status`。
 * 让 runner 只做一次映射（异常 → 一行），而不是在算子内部猜测调用方怎么用。
 */
export class JudgeError extends Error {
  constructor(
    readonly status: CaseResultStatus,
    message: string,
  ) {
    super(message);
    this.name = 'JudgeError';
  }
}

/** 默认最大输出 token：裁判只要一个短 JSON。 */
const DEFAULT_MAX_TOKENS = 512;

/**
 * 渲染裁判 Prompt。
 *
 * 只认三个占位符：`{{input}}` / `{{output}}` / `{{reference}}`。
 * **未知占位符原样保留**（与 `lib/runner/prompt.ts` 同一口径）：
 * 让 `{{unknown}}` 出现在 Prompt 里比悄悄替换成空串更容易被发现。
 */
export function renderJudgePrompt(
  template: string,
  vars: { input: string; output: string; reference: string },
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
    switch (name) {
      case 'input':
      case 'input.query':
        return vars.input;
      case 'output':
        return vars.output;
      case 'reference':
      case 'reference.golden_answer':
        return vars.reference;
      default:
        return whole;
    }
  });
}

/**
 * 从模型文本里解析出 `{ score, reason }`。
 *
 * 解析失败的一律抛 `JudgeError('PARSE_ERROR')`，并带上可诊断的原因 ——
 * `error_message` 是运维唯一能看到的东西，不能只写「解析失败」四个字。
 */
export function parseJudgeVerdict(
  content: string,
  scaleMax: number,
): { score: number; reason: string | null } {
  const extracted = extractJsonText(content);
  if (extracted === null) {
    throw new JudgeError(
      'PARSE_ERROR',
      `裁判输出中未找到 JSON（前 120 字：${content.slice(0, 120)}）`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    throw new JudgeError('PARSE_ERROR', `裁判输出不是合法 JSON：${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JudgeError('PARSE_ERROR', '裁判输出必须是 JSON 对象');
  }

  const raw = (parsed as Record<string, unknown>)['score'];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new JudgeError('PARSE_ERROR', '裁判输出缺少数值型 score 字段');
  }

  // 超量表判为解析失败，不静默 clamp：裁判没按约定的量表打分，结果不可信。
  if (raw < 0 || raw > scaleMax) {
    throw new JudgeError(
      'PARSE_ERROR',
      `裁判给分 ${String(raw)} 超出量表 [0, ${String(scaleMax)}]`,
    );
  }

  const reasonRaw = (parsed as Record<string, unknown>)['reason'];
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() !== '' ? reasonRaw : null;

  return { score: raw, reason };
}

/**
 * 造一个裁判算子。`chat` 由调用方注入（见文件头）。
 *
 * 返回 `ConfigurableOperator<JudgeEvaluatorConfig>`，与六个规则算子同一形态，
 * 这样 `bindByKey` / `bindOperator` 的类型不需要为裁判开特例。
 */
export function createJudgeOperator(deps: { chat: JudgeChat }): ConfigurableOperator<JudgeEvaluatorConfig> {
  return {
    key: 'judge',
    kind: 'judge',
    requiresRetrieval: false,

    async score(ctx: OperatorContext, config: JudgeEvaluatorConfig): Promise<OperatorScore> {
      const base = {
        key: config.key,
        kind: 'judge' as const,
        passed: null,
        threshold: null,
        weight: 1,
      };

      // 目标模型没给出输出 ⇒ 无从裁判。绝不能把空串喂给裁判再当成 0 分。
      if (ctx.actualOutput === null || ctx.actualOutput.trim() === '') {
        throw new JudgeError('FAILED', '目标模型无输出，无法裁判');
      }

      const query = (ctx.input as { query?: unknown }).query;
      const prompt = renderJudgePrompt(config.promptTemplate, {
        input: typeof query === 'string' ? query : '',
        output: ctx.actualOutput,
        reference: ctx.reference?.golden_answer ?? '',
      });

      const outcome = await deps.chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: config.temperature,
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      });

      if (!outcome.ok) {
        // 网关失败原样上抛，保留它给的状态（TIMEOUT / QUOTA_EXCEEDED / …）。
        throw new JudgeError(outcome.status, outcome.message);
      }

      const { score, reason } = parseJudgeVerdict(outcome.content, config.scaleMax);

      // 归一化到 [0,1]：`scaleMax` 是量表上界，契约的 score 恒为归一化值。
      return {
        ...base,
        score: safeScore(score / config.scaleMax),
        reason,
      };
    },
  };
}
