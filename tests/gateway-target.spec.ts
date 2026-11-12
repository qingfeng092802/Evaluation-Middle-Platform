/**
 * 默认直连的回归护栏（`TS-2` · LiteLLM 是可选中间层）。
 *
 * 引入 sidecar 最容易造成的破坏不是「代理不通」，而是**默认行为被悄悄改了**：
 * 升级一次代码，所有既有 run 突然要求先起 docker —— 而门禁在没有 Docker 的
 * 机器上跑，症状只是「今天测试全红」。
 *
 * 所以这里钉的是执行路径本身：不配 `LITELLM_BASE_URL` 时，
 * `executeCase` 发出的请求必须**原样**指向厂商（地址、Bearer、模型名都不变）。
 *
 * 用真 HTTP 服务器（`node:http`，绑 127.0.0.1 随机端口）而不是 mock：
 * 这个文件要断言的正是「请求实际打到了哪里、header 里带的是什么」。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCase } from '../lib/runner/execute-case.js';
import { createJudgeChat } from '../lib/runner/judge-chat.js';
import type { DatasetCase } from '@eval-platform/contracts';

interface Captured {
  url: string;
  auth: string;
  body: Record<string, unknown>;
}

let server: Server;
let captured: Captured[] = [];
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      captured.push({
        url: req.url ?? '',
        auth: req.headers.authorization ?? '',
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"score": 1, "reason": "ok"}' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function caseOf(): DatasetCase {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    datasetVersionId: '22222222-2222-4222-8222-222222222222',
    caseKey: 'c1',
    seq: 0,
    input: { query: '你好' },
    reference: null,
    retrieval: null,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const TARGET = {
  modelProviderId: '33333333-3333-4333-8333-333333333333',
  modelId: 'deepseek-chat',
  promptTemplate: '请回答：{{query}}',
  temperature: 0,
  maxTokens: 64,
  params: null,
};

describe('未配置 LITELLM_BASE_URL ⇒ 直连厂商（M1 行为不变）', () => {
  it('executeCase 的请求打到厂商 baseUrl，并带上厂商 Key', async () => {
    delete process.env['LITELLM_BASE_URL'];
    delete process.env['LITELLM_MASTER_KEY'];
    captured = [];

    const out = await executeCase({
      runId: '00000000-0000-4000-8000-000000000000',
      case: caseOf(),
      target: TARGET,
      provider: { baseUrl, apiKey: 'sk-vendor-direct-9999' },
      evaluators: [],
      priceSnapshot: [],
      resolveJudgeChat: () => null,
    });

    expect(out.status).toBe('OK');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('/v1/chat/completions');
    expect(captured[0]?.auth).toBe('Bearer sk-vendor-direct-9999');
    expect(captured[0]?.body['model']).toBe('deepseek-chat');
  });

  it('裁判调用同样直连（同一个开关，不是两套逻辑）', async () => {
    delete process.env['LITELLM_BASE_URL'];
    captured = [];

    const chat = createJudgeChat({ baseUrl, apiKey: 'sk-vendor-judge-7777', model: 'judge-1' });
    const out = await chat({
      messages: [{ role: 'user', content: '评分' }],
      temperature: 0,
      maxTokens: 16,
    });

    expect(out.ok).toBe(true);
    expect(captured[0]?.auth).toBe('Bearer sk-vendor-judge-7777');
    expect(captured[0]?.body['model']).toBe('judge-1');
  });
});

describe('配置了 LITELLM_BASE_URL ⇒ 请求改走 sidecar，且不透传厂商 Key', () => {
  it('地址换成 sidecar，Bearer 换成 master key（厂商 Key 不出现在 header 里）', async () => {
    process.env['LITELLM_BASE_URL'] = baseUrl;
    process.env['LITELLM_MASTER_KEY'] = 'sk-sidecar-master-1234';
    captured = [];

    try {
      const chat = createJudgeChat({ baseUrl: 'http://vendor.invalid', apiKey: 'sk-must-not-leak', model: 'judge-1' });
      const out = await chat({
        messages: [{ role: 'user', content: '评分' }],
        temperature: 0,
        maxTokens: 16,
      });

      expect(out.ok).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.auth).toBe('Bearer sk-sidecar-master-1234');
      expect(captured[0]?.auth).not.toContain('sk-must-not-leak');
      // 厂商 baseUrl 是无效域名：请求能成功，证明它确实被 sidecar 地址替换了
      expect(captured[0]?.body['model']).toBe('judge-1');
    } finally {
      delete process.env['LITELLM_BASE_URL'];
      delete process.env['LITELLM_MASTER_KEY'];
    }
  });
});
