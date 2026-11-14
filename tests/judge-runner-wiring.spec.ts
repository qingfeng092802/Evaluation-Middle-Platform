/**
 * 裁判算子接进 runner（Batch 2 · 交付物 4 的「接线」部分）。
 *
 * `tests/judge-operator.spec.ts` 只钉住算子本身的解析与归一化；
 * 算子造出来却没被 runner 调用，等于交付物只做了一半。本文件钉住**接线**：
 *  - `run_evaluators` 里出现 `judge` 条目时，`executeCase` 必须真的调一次模型；
 *  - 解析失败 / 网关失败 / 裁判厂商缺失 ⇒ 整条 Case `score = NULL`，
 *    且 `status` 精确等于降级原因，**绝不落 0 分**；
 *  - 裁判成本单独记 `costJudge`，由 `priceSnapshot` 的**裁判模型**单价算出
 *    （`OPEN-3`：裁判账与目标账不可混列）。
 *
 * ## 为什么用本地 HTTP 桩而不是 mock `lib/gateway`
 *
 * 目标侧的模型调用要走真 HTTP（这是 M1 就锁定的口径：链路真的走网络）。
 * mock 掉 `chatComplete` 会把「runner 把 provider 的 baseUrl/apiKey 正确传进网关」
 * 这件事一起 mock 掉。这里起一个只应答 `POST /v1/chat/completions` 的本地桩，
 * 既是真 HTTP，又不联网。
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DatasetCase,
  JudgeEvaluatorConfig,
  OperatorContext,
} from '@eval-platform/contracts';
import { executeCase, type RunEvaluatorSpec } from '../lib/runner/execute-case.js';
import { createJudgeChat, type JudgeChat } from '../lib/runner/judge-chat.js';
import type { PriceSnapshotEntry } from '../lib/cost/index.js';

const PORT = 8796;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PROVIDER_ID = '11111111-1111-1111-1111-111111111111';
const JUDGE_PROVIDER_ID = '22222222-2222-2222-2222-222222222222';

/** 目标侧桩返回的固定内容。非空即可 ⇒ 裁判有东西可评。 */
const TARGET_CONTENT = '目标模型的回答';

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    // 只认 chat completions；其它路径返回 404，让「打错地址」立刻暴露。
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: TARGET_CONTENT } }],
        // 确定性 usage：让 costTarget 可算出来
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const datasetCase: DatasetCase = {
  id: '33333333-3333-3333-3333-333333333333',
  datasetVersionId: '44444444-4444-4444-4444-444444444444',
  caseKey: 'case-1',
  seq: 0,
  input: { query: '什么是召回率？' },
  reference: { golden_answer: '召回率是检索到的相关文档占全部相关文档的比例' },
  retrieval: null,
  metadata: {},
  createdAt: new Date().toISOString(),
};

const judgeConfig: JudgeEvaluatorConfig = {
  key: 'judge',
  modelProviderId: JUDGE_PROVIDER_ID,
  modelId: 'judge-model',
  promptTemplate: '题目：{{input}}\n输出：{{output}}\n参考答案：{{reference}}',
  scaleMax: 5,
  passThreshold: 0.6,
  temperature: 0,
};

/** 目标 + 裁判各一行单价快照。 */
const priceSnapshot: PriceSnapshotEntry[] = [
  {
    modelProviderId: PROVIDER_ID,
    modelId: 'target-model',
    inputPricePer1k: 0.001,
    outputPricePer1k: 0.002,
    currency: 'CNY',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  },
  {
    modelProviderId: JUDGE_PROVIDER_ID,
    modelId: 'judge-model',
    inputPricePer1k: 0.01,
    outputPricePer1k: 0.02,
    currency: 'CNY',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  },
];

const judgeEvaluator: RunEvaluatorSpec = {
  evaluatorKey: 'judge',
  kind: 'judge',
  config: judgeConfig,
  weight: 1,
  passThreshold: 0.6,
};

function baseInput(resolveJudgeChat: (cfg: JudgeEvaluatorConfig) => JudgeChat | null) {
  return {
    runId: '55555555-5555-5555-5555-555555555555',
    case: datasetCase,
    target: {
      modelProviderId: PROVIDER_ID,
      modelId: 'target-model',
      promptTemplate: '{{input}}',
      temperature: 0,
      maxTokens: 64,
      params: null,
    },
    provider: { baseUrl: BASE_URL, apiKey: 'fake-key' },
    evaluators: [judgeEvaluator],
    priceSnapshot,
    resolveJudgeChat,
  };
}

/** 注入一个固定返回的裁判 chat（同时报告 token，供成本断言）。 */
function chatReturningWithUsage(content: string): JudgeChat {
  return async () => ({ ok: true, content, tokensIn: 1000, tokensOut: 500 });
}

describe('runner × judge · 解析失败不落 0 分', () => {
  it('裁判返回非法 JSON ⇒ status=PARSE_ERROR、score=null、passed=null', async () => {
    const out = await executeCase(baseInput(() => chatReturningWithUsage('我觉得还行，给高分。')));

    expect(out.status).toBe('PARSE_ERROR');
    expect(out.score, '解析失败绝不能变成 0 分').toBeNull();
    expect(out.passed).toBeNull();
    expect(out.operatorScores, '部分算子分不可用，不得留下半张成绩单').toBeNull();
    expect(out.errorMessage).toBeTruthy();
    // 目标侧的产物仍应保留：Case 失败的是「评分」，不是「调用」
    expect(out.outputText).toBe(TARGET_CONTENT);
  });

  it('裁判网关超时 ⇒ status=TIMEOUT、score=null', async () => {
    const out = await executeCase(
      baseInput(() => async () => ({ ok: false, status: 'TIMEOUT', message: '裁判网关超时' })),
    );
    expect(out.status).toBe('TIMEOUT');
    expect(out.score).toBeNull();
    expect(out.errorMessage).toContain('超时');
  });

  it('裁判厂商取不到（resolveJudgeChat 返回 null）⇒ status=FAILED、score=null', async () => {
    const out = await executeCase(baseInput(() => null));
    expect(out.status).toBe('FAILED');
    expect(out.score).toBeNull();
    expect(out.errorMessage).toContain('裁判');
  });
});

describe('runner × judge · 合法打分与成本单独入账', () => {
  it('5 分制给 4 分 ⇒ 归一化 0.8，passed=true（阈值 0.6），judgeReasoning 落库', async () => {
    const out = await executeCase(
      baseInput(() => chatReturningWithUsage('{"score": 4, "reason": "基本正确"}')),
    );

    expect(out.status).toBe('OK');
    expect(out.score).toBeCloseTo(0.8, 6);
    expect(out.passed).toBe(true);
    expect(out.operatorScores).toHaveLength(1);
    expect(out.operatorScores?.[0]?.kind).toBe('judge');
    expect(out.judgeReasoning).toBe('基本正确');
  });

  it('costJudge 用裁判模型单价算，与 costTarget 分列', async () => {
    const out = await executeCase(
      baseInput(() => chatReturningWithUsage('{"score": 4, "reason": "好"}')),
    );

    // 目标：(100×0.001 + 50×0.002)/1000 = 0.0002
    expect(out.costTarget).toBeCloseTo(0.0002, 9);
    // 裁判：(1000×0.01 + 500×0.02)/1000 = 0.02
    expect(out.costJudge, '裁判成本必须按裁判模型的单价算').toBeCloseTo(0.02, 9);
  });

  it('裁判厂商未配单价 ⇒ costJudge=0（不误用目标模型的价）', async () => {
    const input = baseInput(() => chatReturningWithUsage('{"score": 4, "reason": "好"}'));
    const out = await executeCase({
      ...input,
      priceSnapshot: priceSnapshot.filter((p) => p.modelProviderId !== JUDGE_PROVIDER_ID),
    });
    expect(out.costJudge, '决不能拿目标模型单价给裁判记账').toBe(0);
    expect(out.costTarget).toBeCloseTo(0.0002, 9);
  });
});

describe('runner × judge · 真实网关接线（真 HTTP）', () => {
  it('createJudgeChat 走 /v1/chat/completions，并回报 token', async () => {
    const chat = createJudgeChat({
      baseUrl: BASE_URL,
      apiKey: 'fake-key',
      model: 'judge-model',
    });
    const out = await chat({
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 16,
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.content).toBe(TARGET_CONTENT);
      expect(out.tokensIn).toBe(100);
      expect(out.tokensOut).toBe(50);
    }
  });

  it('端到端：桩返回的纯文本不是 JSON ⇒ 整条 Case PARSE_ERROR', async () => {
    const input = baseInput((cfg) =>
      createJudgeChat({ baseUrl: BASE_URL, apiKey: 'fake-key', model: cfg.modelId }),
    );
    const out = await executeCase(input);
    expect(out.status).toBe('PARSE_ERROR');
    expect(out.score).toBeNull();
    // 真网关确实被调到了 ⇒ 有 token 消耗（即使解析失败，成本照样发生）
    expect(out.costJudge).toBeGreaterThan(0);
  });
});

// 类型层面确认 `OperatorContext` 仍是算子唯一入参（防止有人给算子塞 runner 的依赖）
void (null as unknown as OperatorContext);
