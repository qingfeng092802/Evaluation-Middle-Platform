/**
 * M4 Batch 4 —— T2 外部 HTTP Target（`US-021`，`BE-M4-12`）。
 *
 * 覆盖三类「写错了也照常渲染」的事：
 *  1. **authHeader 非对称**：写入侧收明文、落库是密文（可解密回原值）、
 *     任何响应/执行结果里都不出现明文（`technical-solution.md` §4）；
 *  2. **PATCH 继承语义**：省略 `authHeader` ⇒ 继承上一版本（同 providers
 *     「省略 apiKey ⇒ 原 Key 保留」先例）；显式给值 ⇒ 覆盖重加密；
 *  3. **执行路径**：requestMapping 按点路径展开请求体、responseMapping 提取
 *     answer/usage；端点不回 usage ⇒ tokens=0（unknown，成本由台账 `unknownCostCases`
 *     计数暴露）；HTTP 500 ⇒ FAILED 无分；缺 answer ⇒ PARSE_ERROR。
 *
 * 出站用**本地真实 HTTP 服务器**捕获（与 callback-token.spec 的派发测试同法）。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Target } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';
import { decryptProviderKey } from '../db/provider-key-cipher.js';
import { resolveTargetExecution, type T2ExecutionConfig } from '../db/repo/targets.js';
import { createEvalRun } from '../lib/runner/create-run.js';
import { executeCase } from '../lib/runner/execute-case.js';

import * as targetsRoute from '../app/api/targets/route.js';
import * as targetIdRoute from '../app/api/targets/[id]/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';
const SECRET = 'Bearer sk-t2-secret-0123456789';
/** 加密密钥（同 providers-admin.spec 的测试环境机制：密文入库在测试里也必须真实发生）。 */
const KEY_SECRET = 'test-provider-key-secret';

function req(
  path: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
  });
}

function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

/** 建一个 T2 目标（含 authHeader），返回 Target（读取侧 Redacted 形状）。 */
async function createT2(endpointUrl = 'http://127.0.0.1:1/hook'): Promise<Target> {
  const res = await targetsRoute.POST(
    req('/api/targets', {
      method: 'POST',
      body: {
        name: '已部署 RAG 应用',
        config: {
          kind: 't2_http',
          endpointUrl,
          authHeader: SECRET,
          requestMapping: { query: 'case.input' },
          responseMapping: { answer: 'answer', 'usage.tokensIn': 'usage.tokens_in' },
        },
      },
    }),
  );
  expect(res.status).toBe(201);
  return Target.parse(await res.json());
}

beforeEach(async () => {
  process.env['PROVIDER_KEY_SECRET'] = KEY_SECRET;
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
  delete process.env['PROVIDER_KEY_SECRET'];
});

describe('T2 目标 · authHeader 非对称（US-021）', () => {
  it('POST → 201；读取侧 Redacted（hasAuthHeader，无明文）；落库是密文且可解密回原值', async () => {
    const t = await createT2();
    expect(t.currentVersion?.config).toMatchObject({ kind: 't2_http', hasAuthHeader: true });
    expect(JSON.stringify(t)).not.toContain('sk-t2-secret');

    const row = await getPool().query<{ auth_header_ciphertext: string }>(
      'SELECT auth_header_ciphertext FROM target_versions ORDER BY version_no DESC LIMIT 1',
    );
    const stored = row.rows[0]!.auth_header_ciphertext;
    expect(stored).not.toBe(SECRET);
    expect(decryptProviderKey(stored)).toBe(SECRET);
  });

  it('PATCH 省略 authHeader ⇒ 继承上一版本；显式给值 ⇒ 覆盖重加密', async () => {
    const t = await createT2();
    // v2：改 endpointUrl + 收窄 responseMapping，不提 authHeader ⇒ 继承
    const patchRes = await targetIdRoute.PATCH(
      req('/api/targets', {
        method: 'PATCH',
        body: { config: { kind: 't2_http', endpointUrl: 'http://127.0.0.1:2/hook', requestMapping: { query: 'case.input' }, responseMapping: { answer: 'answer' } } },
      }),
      params({ id: t.id }),
    );
    expect(patchRes.status).toBe(200);
    await patchRes.json();

    const listVersions = async (): Promise<Array<{ id: string; version_no: number }>> =>
      (
        await getPool().query<{ id: string; version_no: number }>(
          'SELECT id, version_no FROM target_versions WHERE target_id = $1 ORDER BY version_no',
          [t.id],
        )
      ).rows;

    const afterV2 = await listVersions();
    expect(afterV2).toHaveLength(2);
    const v2Row = afterV2[1]!;
    const v2 = (await resolveTargetExecution(v2Row.id)) as T2ExecutionConfig;
    expect(v2.endpointUrl).toBe('http://127.0.0.1:2/hook');
    expect(v2.authHeaderValue).toBe(SECRET); // 继承，不是丢

    // v3：显式换新 header ⇒ 覆盖
    const patch2 = await targetIdRoute.PATCH(
      req('/api/targets', {
        method: 'PATCH',
        body: { config: { kind: 't2_http', endpointUrl: 'http://127.0.0.1:2/hook', authHeader: 'Bearer new-secret', requestMapping: { query: 'case.input' }, responseMapping: { answer: 'answer' } } },
      }),
      params({ id: t.id }),
    );
    expect(patch2.status).toBe(200);
    await patch2.json();
    const afterV3 = await listVersions();
    expect(afterV3).toHaveLength(3);
    const v3 = (await resolveTargetExecution(afterV3[2]!.id)) as T2ExecutionConfig;
    expect(v3.authHeaderValue).toBe('Bearer new-secret');
  });

  it('resolveTargetExecution：T1/T2 各回各的执行形状', async () => {
    const providerId = (
      await getPool().query<{ id: string }>(
        `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked, is_active)
         VALUES ('p-t2x', 'openai_compatible', 'http://127.0.0.1:1/v1', 'noop', 'n•••', true) RETURNING id`,
      )
    ).rows[0]!.id;
    const t1Res = await targetsRoute.POST(
      req('/api/targets', {
        method: 'POST',
        body: {
          name: 't1 目标',
          config: {
            kind: 't1_prompt',
            modelProviderId: providerId,
            modelId: 'm1',
            promptTemplate: '{{input}}',
            temperature: 0,
            maxTokens: 64,
          },
        },
      }),
    );
    const t1 = Target.parse(await t1Res.json());
    const t1Exec = await resolveTargetExecution(t1.currentVersion!.id);
    expect(t1Exec).toMatchObject({ kind: 't1_prompt', modelId: 'm1', modelProviderId: providerId });

    const t2 = await createT2();
    const t2Exec = await resolveTargetExecution(t2.currentVersion!.id);
    expect(t2Exec).toMatchObject({ kind: 't2_http', authHeaderValue: SECRET });
  });
});

describe('T2 run 创建（不被 provider 阻塞）', () => {
  it('无启用厂商 + T2 + rule 算子 ⇒ 可建 run；快照含 targetKind/endpointUrl，无明文', async () => {
    const w = await buildCompareWorld({
      name: 't2run',
      baseline: { name: 'b', evaluators: [], cases: [{ caseKey: 'c1', score: 0.5 }] },
      current: { name: 'c', evaluators: [], cases: [{ caseKey: 'c1', score: 0.5 }] },
    });
    const t = await createT2();
    const tvId = t.currentVersion!.id;

    const runId = await createEvalRun({
      name: 't2 首跑',
      datasetVersionId: w.datasetVersionId,
      targetVersionId: tvId,
      concurrency: 2,
      evaluators: [{ config: { key: 'regex', pattern: '.' }, weight: 1 }],
      triggerSource: 'MANUAL',
    });
    expect(runId).toBeTruthy();

    const row = await getPool().query<{ config_snapshot: Record<string, unknown> }>(
      'SELECT config_snapshot FROM eval_runs WHERE id = $1',
      [runId],
    );
    const snap = row.rows[0]!.config_snapshot;
    expect(snap).toMatchObject({ targetKind: 't2_http' });
    expect(JSON.stringify(snap)).toContain('/hook');
    expect(JSON.stringify(snap)).not.toContain('sk-t2-secret');
  });
});

describe('T2 执行路径（本地 HTTP 捕获）', () => {
  interface Captured {
    auth: string | null;
    body: Record<string, unknown>;
    replyWith: (status: number, payload: unknown) => void;
  }

  async function serve(handler: (c: Captured) => void): Promise<string> {
    const server = http.createServer((req2, res2) => {
      let raw = '';
      req2.on('data', (c: Buffer) => {
        raw += c;
      });
      req2.on('end', () => {
        const captured: Captured = {
          auth: req2.headers['authorization'] ?? null,
          body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
          replyWith: (status, payload) => {
            res2.statusCode = status;
            res2.setHeader('content-type', 'application/json');
            res2.end(JSON.stringify(payload));
          },
        };
        handler(captured);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/invoke`;
    // 测试结束再关：执行器同步等响应，这里无需显式 close（进程退出兜底）
    void server;
    return url;
  }

  const baseCase = {
    id: '00000000-0000-4000-8000-0000000000c1',
    datasetVersionId: '00000000-0000-4000-8000-0000000000v1',
    caseKey: 'c1',
    seq: 0,
    input: { query: '什么是评测中台' },
    reference: null,
    retrieval: null,
    metadata: {},
    createdAt: '2026-11-18T00:00:00Z',
  };

  function t2Target(endpointUrl: string, responseMapping: Record<string, string>) {
    return {
      kind: 't2_http' as const,
      endpointUrl,
      authHeaderValue: SECRET,
      requestMapping: { query: 'case.input' },
      responseMapping,
    };
  }

  it('请求按 requestMapping 展开、Authorization 到达端点、响应按 responseMapping 提取', async () => {
    const received: Captured[] = [];
    const url = await serve((c) => {
      received.push(c);
      c.replyWith(200, {
        answer: '评测中台是……',
        usage: { tokens_in: 12, tokens_out: 34 },
      });
    });

    const outcome = await executeCase({
      runId: '00000000-0000-4000-8000-0000000000r1',
      case: baseCase,
      target: t2Target(url, { answer: 'answer', 'usage.tokensIn': 'usage.tokens_in', 'usage.tokensOut': 'usage.tokens_out', 'usage.costTarget': 'usage.cost' }),
      provider: { baseUrl: '', apiKey: '' },
      evaluators: [{ evaluatorKey: 'regex', kind: 'rule', config: { key: 'regex', pattern: '评测', caseSensitive: false, shouldMatch: true }, weight: 1, passThreshold: null }],
      priceSnapshot: [],
      resolveJudgeChat: () => null,
    });

    expect(outcome.status).toBe('OK');
    // 平台变量 `case.input` ⇒ input.query 字符串
    expect(received[0]?.body).toMatchObject({ query: '什么是评测中台' });
    expect(received[0]?.auth).toBe(SECRET);
    expect(outcome.outputText).toBe('评测中台是……');
    expect(outcome.tokensIn).toBe(12);
    expect(outcome.tokensOut).toBe(34);
    expect(outcome.costTarget).toBe(0); // 端点未报 cost ⇒ 0 + 台账 unknown 计数
    // 算子照跑（regex 命中「评测」）
    expect(outcome.operatorScores?.[0]?.score).toBe(1);
    // 明文不出现在结果对象里
    expect(JSON.stringify(outcome)).not.toContain('sk-t2-secret');
  });

  it('端点不回 usage ⇒ tokens=0（unknown 语义），无分不冒充', async () => {
    const url = await serve((c) => {
      c.replyWith(200, { answer: '只有答案' });
    });
    const outcome = await executeCase({
      runId: '00000000-0000-4000-8000-0000000000r2',
      case: baseCase,
      target: t2Target(url, { answer: 'answer' }),
      provider: { baseUrl: '', apiKey: '' },
      evaluators: [],
      priceSnapshot: [],
      resolveJudgeChat: () => null,
    });
    expect(outcome.status).toBe('OK');
    expect(outcome.outputText).toBe('只有答案');
    expect(outcome.tokensIn).toBe(0);
    expect(outcome.tokensOut).toBe(0);
    expect(outcome.costTarget).toBe(0);
  });

  it('HTTP 500 ⇒ FAILED 无分；缺 answer ⇒ PARSE_ERROR', async () => {
    const badUrl = await serve((c) => {
      c.replyWith(500, { error: 'boom' });
    });
    const failed = await executeCase({
      runId: '00000000-0000-4000-8000-0000000000r3',
      case: baseCase,
      target: t2Target(badUrl, { answer: 'answer' }),
      provider: { baseUrl: '', apiKey: '' },
      evaluators: [],
      priceSnapshot: [],
      resolveJudgeChat: () => null,
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.score).toBeNull();

    const emptyUrl = await serve((c) => {
      c.replyWith(200, { whatever: 1 });
    });
    const parse = await executeCase({
      runId: '00000000-0000-4000-8000-0000000000r4',
      case: baseCase,
      target: t2Target(emptyUrl, { answer: 'answer' }),
      provider: { baseUrl: '', apiKey: '' },
      evaluators: [],
      priceSnapshot: [],
      resolveJudgeChat: () => null,
    });
    expect(parse.status).toBe('PARSE_ERROR');
    expect(parse.score).toBeNull();
  });
});
