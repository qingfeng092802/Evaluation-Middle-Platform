/**
 * 裁判模型调用的生产实现（Batch 2 · 交付物 4 的「接线」）。
 *
 * ## 这一层为什么存在
 *
 * `lib/operators/judge.ts` 刻意不自己发网络请求（算子必须纯），它的 `chat` 依赖
 * 由外部注入。`lib/operators/index.ts` 又刻意不 import `db`。于是「一次真实网关调用」
 * 这条缝就得有人填 —— 就是本文件：把 `lib/gateway` 的 `chatComplete` 适配成
 * `JudgeChat` 形状，并**把 token 用量带出来**（裁判成本要单独入账，`OPEN-3`）。
 *
 * ## 为什么必须回报 token
 *
 * 只回 `content` 的话，裁判成本无从计算，只能记 0 —— 那等于把裁判开销从账上抹掉。
 * 尤其解析失败时（`PARSE_ERROR`）模型调用是**真的发生了**，钱也真的花了，
 * 成本必须照记，只是分数为空。
 */
import { chatComplete } from '../gateway/index.js';
import { chatTargetFromEnv } from '../gateway/target.js';
import type { JudgeChat, JudgeChatOutcome } from '../operators/judge.js';

export type { JudgeChat } from '../operators/judge.js';

export interface JudgeChatOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 单次超时（毫秒）。缺省沿用网关的 30s。 */
  readonly timeoutMs?: number | undefined;
}

/**
 * 造一个走真实网关的 `JudgeChat`。
 *
 * 失败时把网关给的 `status` 原样透出（`TIMEOUT` / `QUOTA_EXCEEDED` / `FAILED` / …），
 * 由 runner 决定怎么写 `eval_case_results.status` —— 这一层不做业务解释。
 */
export function createJudgeChat(opts: JudgeChatOptions): JudgeChat {
  return async (req): Promise<JudgeChatOutcome> => {
    const outcome = await chatComplete({
      // 裁判模型与目标模型走同一套「直连 / 经 sidecar」判定，否则会出现
      // 「目标模型经代理、裁判直连」这种只在一个方向上暴露厂商 Key 的半吊子配置。
      ...chatTargetFromEnv(opts),
      model: opts.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });

    if (!outcome.ok) {
      return { ok: false, status: outcome.status, message: outcome.message };
    }
    return {
      ok: true,
      content: outcome.content,
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
    };
  };
}
