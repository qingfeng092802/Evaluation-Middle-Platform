/**
 * LLM-as-a-Judge 算子的行为级单测（Batch 2 · 交付物 4 / 准出条件 3）。
 *
 * ## 这条准出条件在防什么
 *
 * 原文：「**Judge 非法 JSON 降级**单测 100% 绿灯（→ `PARSE_ERROR` + `score IS NULL`，**不落 0 分**）」。
 *
 * 「不落 0 分」是全部要点。裁判模型返回一段无法解析的文本时，如果实现图省事写
 * `score = 0`，报表上就会把「裁判没答出来」记成「模型质量为零」——这两件事在
 * 任何复盘里都是相反的结论。契约 `OperatorScore.score` 是 `min(0)`，**无法表达
 * `null`**，所以降级不能靠返回值，只能靠**抛出带状态码的异常**，
 * 由 runner 把整条 Case 记成 `status='PARSE_ERROR'` 且 `score=null`。
 *
 * ## 为什么注入 chat 而不是在算子内部发请求
 *
 * `lib/operators/index.ts` 的模块注释与 `eval-contracts.ts` 的 `OperatorContext`
 * 注释都写死了一条：**算子不得访问数据库、不得自己发网络请求**，裁判的那一次
 * 模型调用由 runner 注入。否则六个算子会各自长出并发/重试/超时逻辑（`TS-3` 短板 2）。
 * 因此这里用 `createJudgeOperator({ chat })` 工厂，测试里注入假 chat，生产里由
 * runner 注入基于 `lib/gateway` 的实现。
 */
import { describe, expect, it } from 'vitest';
import type { JudgeEvaluatorConfig, OperatorContext } from '@eval-platform/contracts';
import { createJudgeOperator, JudgeError } from '../lib/operators/judge.js';

/** 只填裁判会用到的字段；其余留空，让用例聚焦在解析与归一化上。 */
function ctx(over: Partial<OperatorContext> = {}): OperatorContext {
  return {
    caseKey: 'case-1',
    input: { query: '什么是召回率？' },
    reference: { golden_answer: '召回率是检索到的相关文档占全部相关文档的比例' },
    retrievalAnnotation: null,
    actualOutput: '召回率 = 检索到的相关文档 / 全部相关文档',
    outputRaw: null,
    retrievedContexts: null,
    ...over,
  };
}

const cfg = (over: Partial<JudgeEvaluatorConfig> = {}): JudgeEvaluatorConfig => ({
  key: 'judge',
  modelProviderId: '11111111-1111-1111-1111-111111111111',
  modelId: 'judge-model',
  promptTemplate: '题目：{{input}}\n模型输出：{{output}}\n参考答案：{{reference}}',
  scaleMax: 5,
  passThreshold: 0.6,
  temperature: 0,
  ...over,
});

/** 一个永远返回固定文本的假 chat（token 用量与解析无关，这里给固定值）。 */
function chatReturning(content: string) {
  return async (): Promise<{ ok: true; content: string; tokensIn: number; tokensOut: number }> => ({
    ok: true,
    content,
    tokensIn: 100,
    tokensOut: 20,
  });
}

// ---------------------------------------------------------------------------
// 准出条件 3：非法 JSON 降级 ⇒ 抛 PARSE_ERROR，绝不返回 0 分
// ---------------------------------------------------------------------------

describe('Judge · 非法 JSON 必须降级为 PARSE_ERROR，绝不落 0 分', () => {
  it('返回纯文本（无 JSON）⇒ 抛 JudgeError，status=PARSE_ERROR', async () => {
    const op = createJudgeOperator({ chat: chatReturning('我觉得这条回答还不错，给个高分吧。') });

    // 关键：不是 `score === 0`，而是**抛出**。若这里返回到值上，
    // 上层就没有任何办法把「解析失败」与「真的得了 0 分」区分开。
    await expect(op.score(ctx(), cfg())).rejects.toBeInstanceOf(JudgeError);
    await expect(op.score(ctx(), cfg())).rejects.toMatchObject({ status: 'PARSE_ERROR' });
  });

  it('JSON 缺 score 字段 ⇒ 抛 JudgeError，status=PARSE_ERROR', async () => {
    const op = createJudgeOperator({
      chat: chatReturning('{"reason": "写得还行", "verdict": "ok"}'),
    });
    await expect(op.score(ctx(), cfg())).rejects.toMatchObject({ status: 'PARSE_ERROR' });
  });

  it('score 超出 scaleMax ⇒ 抛 JudgeError，status=PARSE_ERROR（不静默截断）', async () => {
    // scaleMax=5 却给了 9 分：静默 clamp 成 1.0 会让「裁判没按量表打分」这个
    // 事实被掩盖，报表上看起来一切正常。宁可判为解析失败。
    const op = createJudgeOperator({ chat: chatReturning('{"score": 9, "reason": "满分"}') });
    await expect(op.score(ctx(), cfg())).rejects.toMatchObject({ status: 'PARSE_ERROR' });
  });

  it('gateway 失败（非解析问题）⇒ 抛出并带上网关给的状态，不返回 0 分', async () => {
    const op = createJudgeOperator({
      chat: async () => ({ ok: false as const, status: 'TIMEOUT' as const, message: '网关超时' }),
    });
    await expect(op.score(ctx(), cfg())).rejects.toMatchObject({ status: 'TIMEOUT' });
  });
});

// ---------------------------------------------------------------------------
// 正常路径：scaleMax 归一化
// ---------------------------------------------------------------------------

describe('Judge · 合法 JSON 按 scaleMax 归一化到 [0,1]', () => {
  it('5 分制给 4 分 ⇒ 0.8，reason 原样保留', async () => {
    const op = createJudgeOperator({
      chat: chatReturning('{"score": 4, "reason": "基本正确，遗漏了分母的定义"}'),
    });
    const r = await op.score(ctx(), cfg({ scaleMax: 5 }));
    expect(r.score).toBeCloseTo(0.8, 6);
    expect(r.kind).toBe('judge');
    expect(r.reason).toBe('基本正确，遗漏了分母的定义');
  });

  it('10 分制给 7 分 ⇒ 0.7', async () => {
    const op = createJudgeOperator({ chat: chatReturning('{"score": 7, "reason": "较好"}') });
    const r = await op.score(ctx(), cfg({ scaleMax: 10 }));
    expect(r.score).toBeCloseTo(0.7, 6);
  });

  it('1 分制给 0 分 ⇒ 0.0（这是**真的** 0 分，与解析失败必须可区分）', async () => {
    // 这条与上面的降级用例成对：合法的 0 分照常返回 0，只有解析失败才抛。
    const op = createJudgeOperator({ chat: chatReturning('{"score": 0, "reason": "完全错误"}') });
    const r = await op.score(ctx(), cfg({ scaleMax: 1 }));
    expect(r.score).toBe(0);
  });

  it('prompt 中的 {{input}} / {{output}} / {{reference}} 会被真实内容替换', async () => {
    let seen = '';
    const op = createJudgeOperator({
      chat: async (req) => {
        seen = req.messages[req.messages.length - 1]?.content ?? '';
        return { ok: true as const, content: '{"score": 5, "reason": "好"}', tokensIn: 100, tokensOut: 20 };
      },
    });
    await op.score(ctx(), cfg({ scaleMax: 5 }));
    expect(seen).toContain('什么是召回率？');
    expect(seen).toContain('召回率 = 检索到的相关文档 / 全部相关文档');
    expect(seen).toContain('召回率是检索到的相关文档占全部相关文档的比例');
  });

  it('模型输出为 null（目标模型失败）⇒ 抛 JudgeError，不把空串当 0 分', async () => {
    const op = createJudgeOperator({ chat: chatReturning('{"score": 0, "reason": "空"}') });
    await expect(op.score(ctx({ actualOutput: null }), cfg())).rejects.toBeInstanceOf(JudgeError);
  });
});
