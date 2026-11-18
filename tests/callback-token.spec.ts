/**
 * M4 Batch 3 —— 回调 Token 生命周期与出站派发（`US-018`，Q1=C 拉取模式）。
 *
 * 覆盖三类「写错了也照常渲染」的事：
 *  1. Token 明文仅返回一次、二次签发得到不同明文（每次签发独立，平台只存哈希）；
 *  2. 拉取鉴权 fail-closed：无 Token / 错 Token / 跨评测集 Token → 一律 401；
 *  3. 出站派发：feishu / wecom / webhook 三种 channel 各自的载荷形状，
 *     且派发失败不阻塞结果响应。
 *
 * 出站派发用**本地真实 HTTP 服务器**捕获（外呼是真实 HTTP，不是 mock fetch）。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CallbackTokenResponse, GateResultResponse } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld, type CompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

import * as gatesRoute from '../app/api/gates/route.js';
import * as tokenRoute from '../app/api/gates/[gateId]/callback-token/route.js';
import * as resultsRoute from '../app/api/gates/results/[runId]/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';

function req(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
});

// ---------------------------------------------------------------------------
// 回调 Token 签发
// ---------------------------------------------------------------------------

describe('POST /api/gates/{gateId}/callback-token · 签发', () => {
  it('签发 → 200 + CallbackTokenResponse（expiresAt=null，MVP 不过期口径）', async () => {
    const w = await buildCompareWorld({
      name: 'tok',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [] },
    });
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: 'L1', datasetId: w.datasetId, condition: { metric: 'score_overall', op: '<', value: 0.85 } },
      }),
    );
    const gateId = (await getPool().query<{ id: string }>('SELECT id FROM regression_gates LIMIT 1')).rows[0]!.id;

    const res = await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }));
    expect(res.status).toBe(200);
    const body = CallbackTokenResponse.parse(await res.json());
    expect(body.token.length).toBeGreaterThanOrEqual(32);
    expect(body.expiresAt).toBeNull();
  });

  it('两次签发 → 不同明文（每次签发独立；平台只存哈希，明文仅一次可见）', async () => {
    const w = await buildCompareWorld({
      name: 'tok2',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [] },
    });
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: 'L1', datasetId: w.datasetId, condition: { metric: 'score_overall', op: '<', value: 0.85 } },
      }),
    );
    const gateId = (await getPool().query<{ id: string }>('SELECT id FROM regression_gates LIMIT 1')).rows[0]!.id;

    const r1 = CallbackTokenResponse.parse(
      await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }))).json(),
    );
    const r2 = CallbackTokenResponse.parse(
      await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }))).json(),
    );
    expect(r1.token).not.toBe(r2.token);
  });

  it('未知 gateId → 404', async () => {
    const res = await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId: '00000000-0000-4000-8000-000000000000' }));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 拉取鉴权（fail-closed；Token 绑定其门禁的评测集，防跨集越权）
// ---------------------------------------------------------------------------

describe('GET /api/gates/results/{runId} · 拉取鉴权', () => {
  let world: CompareWorld;
  let token = '';

  beforeEach(async () => {
    world = await buildCompareWorld({
      name: 'auth',
      baseline: {
        name: 'b',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [{ caseKey: 'c1', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] }],
        metrics: { scoreOverall: 0.5 },
      },
      current: {
        name: 'c',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [{ caseKey: 'c1', score: 0.6, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.6 }] }],
        metrics: { scoreOverall: 0.6 },
      },
    });
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: 'L1', datasetId: world.datasetId, condition: { metric: 'score_overall', op: '<', value: 0.85 } },
      }),
    );
    const gateId = (await getPool().query<{ id: string }>('SELECT id FROM regression_gates LIMIT 1')).rows[0]!.id;
    token = CallbackTokenResponse.parse(
      await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }))).json(),
    ).token;
  });

  it('无 X-Callback-Token 头 → 401（fail-closed）', async () => {
    const res = await resultsRoute.GET(req(`/api/gates/results/${world.currentRunId}`), params({ runId: world.currentRunId }));
    expect(res.status).toBe(401);
  });

  it('错 Token → 401', async () => {
    const res = await resultsRoute.GET(
      req(`/api/gates/results/${world.currentRunId}`, { headers: { 'x-callback-token': 'wrong-token' } }),
      params({ runId: world.currentRunId }),
    );
    expect(res.status).toBe(401);
  });

  it('合法 Token → 200 + GateResultEnvelope', async () => {
    const res = await resultsRoute.GET(
      req(`/api/gates/results/${world.currentRunId}`, { headers: { 'x-callback-token': token } }),
      params({ runId: world.currentRunId }),
    );
    expect(res.status).toBe(200);
    const body = GateResultResponse.parse(await res.json());
    // beforeEach 里 L1（BLOCK，0.6 < 0.85）处于启用态 ⇒ 判定引擎会求值 ⇒ FAIL（不是 NO_GATE）
    expect(body.gateResult.overall).toBe('FAIL');
  });

  it('跨评测集 Token → 401（防越权拉取其他评测集的结果）', async () => {
    const other = await buildCompareWorld({
      name: 'auth-other',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [] },
    });
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: 'other-gate', datasetId: other.datasetId, condition: { metric: 'score_overall', op: '<', value: 0.85 } },
      }),
    );
    const otherGateId = (
      await getPool().query<{ id: string }>('SELECT id FROM regression_gates WHERE dataset_id = $1 LIMIT 1', [other.datasetId])
    ).rows[0]!.id;
    const otherToken = CallbackTokenResponse.parse(
      await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId: otherGateId }))).json(),
    ).token;

    const res = await resultsRoute.GET(
      req(`/api/gates/results/${world.currentRunId}`, { headers: { 'x-callback-token': otherToken } }),
      params({ runId: world.currentRunId }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 出站派发（US-018：评测结束后把结论推送到配置的渠道；本地真实 HTTP 捕获）
// ---------------------------------------------------------------------------

describe('出站派发 · 本地 HTTP 服务器捕获（真实外呼）', () => {
  it('feishu / wecom / webhook channel 各收到一次其形状的 POST', async () => {
    const received: Array<{ url: string; body: unknown }> = [];
    const server = http.createServer((req2, res2) => {
      let raw = '';
      req2.on('data', (c: Buffer) => {
        raw += c;
      });
      req2.on('end', () => {
        received.push({ url: req2.url ?? '', body: raw === '' ? null : JSON.parse(raw) });
        res2.statusCode = 200;
        res2.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const w = await buildCompareWorld({
        name: 'dispatch',
        baseline: {
          name: 'b',
          evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
          cases: [{ caseKey: 'c1', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] }],
          metrics: { scoreOverall: 0.5 },
        },
        current: {
          name: 'c',
          evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
          cases: [{ caseKey: 'c1', score: 0.3, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.3 }] }],
          metrics: { scoreOverall: 0.3 },
        },
      });
      await gatesRoute.POST(
        req('/api/gates', {
          method: 'POST',
          body: {
            name: 'L1 dispatch',
            datasetId: w.datasetId,
            condition: { metric: 'score_overall', op: '<', value: 0.85 },
            action: 'BLOCK',
            channels: [
              { kind: 'feishu', url: `http://127.0.0.1:${port}/feishu` },
              { kind: 'wecom', url: `http://127.0.0.1:${port}/wecom` },
              { kind: 'webhook', url: `http://127.0.0.1:${port}/webhook` },
            ],
          },
        }),
      );

      const gateId = (
        await getPool().query<{ id: string }>('SELECT id FROM regression_gates WHERE dataset_id = $1 LIMIT 1', [w.datasetId])
      ).rows[0]!.id;
      const token = CallbackTokenResponse.parse(
        await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }))).json(),
      ).token;
      await resultsRoute.GET(
        req(`/api/gates/results/${w.currentRunId}`, { headers: { 'x-callback-token': token } }),
        params({ runId: w.currentRunId }),
      );
      // 派发在求值时触发；给后台外呼一点时间落地
      await new Promise((r) => setTimeout(r, 1_000));

      const byPath = Object.fromEntries(received.map((r) => [r.url, r.body]));
      // feishu：{msg_type:'text', content:{text}}
      expect(byPath['/feishu']).toMatchObject({ msg_type: 'text', content: { text: expect.stringContaining('FAIL') } });
      // wecom：{msgtype:'markdown', markdown:{content}}
      expect(byPath['/wecom']).toMatchObject({ msgtype: 'markdown', markdown: { content: expect.stringContaining('FAIL') } });
      // webhook（通用）：信封摘要含 overall
      expect(byPath['/webhook']).toMatchObject({ overall: 'FAIL' });
    } finally {
      server.close();
    }
  }, 60_000);

  it('出站失败（channel 不可达）不阻塞结果响应', async () => {
    const w = await buildCompareWorld({
      name: 'dispatch-fail',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [] },
    });
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'L1',
          datasetId: w.datasetId,
          condition: { metric: 'score_overall', op: '<', value: 0.85 },
          action: 'BLOCK',
          channels: [{ kind: 'webhook', url: 'http://127.0.0.1:1/unreachable' }],
        },
      }),
    );
    const gateId = (
      await getPool().query<{ id: string }>('SELECT id FROM regression_gates WHERE dataset_id = $1 LIMIT 1', [w.datasetId])
    ).rows[0]!.id;
    const token = CallbackTokenResponse.parse(
      await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }))).json(),
    ).token;
    const res = await resultsRoute.GET(
      req(`/api/gates/results/${w.currentRunId}`, { headers: { 'x-callback-token': token } }),
      params({ runId: w.currentRunId }),
    );
    // 派发失败被吞掉（console.warn），结果响应本身不受影响
    expect(res.status).toBe(200);
    const body = GateResultResponse.parse(await res.json());
    expect(body.gateResult.overall).toBe('FAIL');
  });
});
