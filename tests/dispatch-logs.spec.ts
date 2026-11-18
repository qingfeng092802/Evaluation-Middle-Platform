/**
 * M4 收尾 —— 出站派发留痕（0021 `outbound_dispatch_logs`）与派发历史查询。
 *
 * 覆盖：
 *  1. 每次派发尝试落一行：SUCCESS / FAILED 都落（只记失败会让「到底发没发出去」不可问）；
 *  2. 失败必带原因：网络异常与 HTTP 非 2xx 都记 FAILED（`fetch` 对非 2xx **不抛错**，
 *     不显式判 `res.ok` 就会把渠道端 4xx/5xx 静默当成成功）；
 *  3. 派发失败不阻塞结果响应（渠道不可达是常态）；
 *  4. `GET /api/gates/{gateId}/dispatch-logs` 输出与落库一致（按 dispatched_at 倒序）；
 *  5. `GET /api/baselines`：状态过滤 + `runSummary.runName`（openapi 已先行定义的契约，
 *     实现补位 —— PG-09「基线确认」Tab 的数据面）。
 *
 * 外呼用**本地真实 HTTP 服务器**捕获（真实 HTTP，不是 mock fetch），同 callback-token.spec 范式。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BaselineListResponse,
  CallbackTokenResponse,
  DispatchLogListResponse,
  GateResultResponse,
} from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld, type CompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

import * as gatesRoute from '../app/api/gates/route.js';
import * as logsRoute from '../app/api/gates/[gateId]/dispatch-logs/route.js';
import * as tokenRoute from '../app/api/gates/[gateId]/callback-token/route.js';
import * as resultsRoute from '../app/api/gates/results/[runId]/route.js';
import * as baselinesRoute from '../app/api/baselines/route.js';
import * as decisionRoute from '../app/api/baselines/[baselineId]/decision/route.js';

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

/** 轮询直到条件成立（派发是 await 内联的，正常情况下首查即中；兜底防抖）。 */
async function until<T>(fn: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('等待派发落库超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 建一个带渠道的门禁并返回 gateId（dispatch 逻辑由 GET results 触发）。 */
async function createGateWithChannels(
  w: CompareWorld,
  channels: Array<{ kind: 'feishu' | 'wecom' | 'webhook'; url: string }>,
): Promise<string> {
  await gatesRoute.POST(
    req('/api/gates', {
      method: 'POST',
      body: {
        name: 'L1 dispatch-log',
        datasetId: w.datasetId,
        condition: { metric: 'score_overall', op: '<', value: 0.85 },
        action: 'BLOCK',
        channels,
      },
    }),
  );
  return (
    await getPool().query<{ id: string }>(
      'SELECT id FROM regression_gates WHERE dataset_id = $1 LIMIT 1',
      [w.datasetId],
    )
  ).rows[0]!.id;
}

/** 触发一次「求值 + 派发」。 */
async function pullResults(w: CompareWorld, gateId: string): Promise<void> {
  const token = CallbackTokenResponse.parse(
    await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }))).json(),
  ).token;
  const res = await resultsRoute.GET(
    req(`/api/gates/results/${w.currentRunId}`, { headers: { 'x-callback-token': token } }),
    params({ runId: w.currentRunId }),
  );
  expect(res.status).toBe(200);
  expect(GateResultResponse.parse(await res.json()).gateResult.overall).toBe('FAIL');
}

// ---------------------------------------------------------------------------
// 派发落库
// ---------------------------------------------------------------------------

describe('出站派发留痕（0021）', () => {
  it('SUCCESS 与 FAILED 都落行；HTTP 500 显式记 FAILED 并带状态码原因', async () => {
    const hits: string[] = [];
    const server = http.createServer((req2, res2) => {
      req2.resume(); // 消费请求体；本用例只关心 URL 与响应码，不校验载荷
      req2.on('end', () => {
        hits.push(req2.url ?? '');
        if (req2.url === '/ok') {
          res2.statusCode = 200;
          res2.end('ok');
        } else {
          res2.statusCode = 500;
          res2.end('boom');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const w = await buildCompareWorld({
        name: 'dispatch-log',
        baseline: { name: 'b', evaluators: [], cases: [] },
        current: { name: 'c', evaluators: [], cases: [] },
      });
      const gateId = await createGateWithChannels(w, [
        { kind: 'webhook', url: `http://127.0.0.1:${port}/ok` },
        { kind: 'webhook', url: `http://127.0.0.1:${port}/boom` },
      ]);
      await pullResults(w, gateId);

      const rows = await until(async () => {
        const r = await getPool().query<{
          channel_url: string;
          status: string;
          error_message: string | null;
          retry_count: number;
        }>(
          `SELECT channel_url, status, error_message, retry_count
             FROM outbound_dispatch_logs WHERE gate_id = $1 ORDER BY channel_url`,
          [gateId],
        );
        return r.rows.length === 2 ? r.rows : null;
      });

      const byUrl = Object.fromEntries(rows.map((r) => [r.channel_url, r]));
      expect(byUrl[`http://127.0.0.1:${port}/ok`]).toMatchObject({ status: 'SUCCESS', error_message: null });
      expect(byUrl[`http://127.0.0.1:${port}/boom`]).toMatchObject({
        status: 'FAILED',
        error_message: expect.stringContaining('500'),
      });
      // retry_count 按规格落列；当前无重试引擎，恒为 0（不编造重试）
      expect(rows.every((r) => r.retry_count === 0)).toBe(true);
      // 渠道确实都被真实外呼命中
      expect(hits.sort()).toEqual(['/boom', '/ok']);
    } finally {
      server.close();
    }
  }, 60_000);

  it('网络不可达 → FAILED 行含原因，且不阻塞结果响应', async () => {
    const w = await buildCompareWorld({
      name: 'dispatch-log-fail',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [] },
    });
    const gateId = await createGateWithChannels(w, [
      { kind: 'webhook', url: 'http://127.0.0.1:1/unreachable' },
    ]);
    await pullResults(w, gateId);

    const row = await until(async () => {
      const r = await getPool().query<{ status: string; error_message: string | null }>(
        `SELECT status, error_message FROM outbound_dispatch_logs WHERE gate_id = $1`,
        [gateId],
      );
      return r.rows[0] ?? null;
    });
    expect(row.status).toBe('FAILED');
    expect(row.error_message).toBeTruthy();
  }, 60_000);

  it('GET /api/gates/{gateId}/dispatch-logs：与落库一致、dispatched_at 倒序、gate 不存在 404', async () => {
    const w = await buildCompareWorld({
      name: 'dispatch-log-list',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [] },
    });
    const gateId = await createGateWithChannels(w, [
      { kind: 'feishu', url: 'http://127.0.0.1:1/feishu' },
    ]);
    await pullResults(w, gateId);
    await until(async () => {
      const r = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbound_dispatch_logs WHERE gate_id = $1`,
        [gateId],
      );
      return r.rows[0]!.n === '1' ? true : null;
    });

    const res = await logsRoute.GET(req(`/api/gates/${gateId}/dispatch-logs`), params({ gateId }));
    expect(res.status).toBe(200);
    const body = DispatchLogListResponse.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!).toMatchObject({
      gateId,
      evalRunId: w.currentRunId,
      channelKind: 'feishu',
      status: 'FAILED',
      retryCount: 0,
      errorMessage: expect.any(String),
    });
    expect(body.items[0]!.payload).toBeTruthy();

    const missing = await logsRoute.GET(
      req('/api/gates/00000000-0000-4000-8000-000000000000/dispatch-logs'),
      params({ gateId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(missing.status).toBe(404);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 基线列表（PG-09「基线确认」Tab 数据面，openapi 已先行定义）
// ---------------------------------------------------------------------------

describe('GET /api/baselines · 待确认提名列表', () => {
  it('列表含 runSummary.runName；status 过滤 NOMINATED/CONFIRMED/REJECTED 生效', async () => {
    const w = await buildCompareWorld({
      name: 'baseline-list',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [] },
    });
    await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: w.datasetId, evalRunId: w.baselineRunId, note: '三连跑全绿' },
      }),
    );

    const all = BaselineListResponse.parse(
      await (
        await baselinesRoute.GET(req(`/api/baselines?datasetId=${w.datasetId}`))
      ).json(),
    );
    expect(all.items).toHaveLength(1);
    expect(all.items[0]!).toMatchObject({ status: 'NOMINATED', note: '三连跑全绿' });
    expect(all.items[0]!.runSummary?.runName).toBeTruthy();

    // ROLE-B 确认后：NOMINATED 过滤清空、CONFIRMED 过滤命中
    const confirmedId = all.items[0]!.id;
    const decided = await decisionRoute.POST(
      req(`/api/baselines/${confirmedId}/decision`, {
        method: 'POST',
        body: { approve: true },
        headers: { 'x-role': 'B' },
      }),
      params({ baselineId: confirmedId }),
    );
    expect(decided.status).toBe(200);

    const nominated = BaselineListResponse.parse(
      await (
        await baselinesRoute.GET(req(`/api/baselines?datasetId=${w.datasetId}&status=NOMINATED`))
      ).json(),
    );
    expect(nominated.items).toHaveLength(0);

    const confirmed = BaselineListResponse.parse(
      await (
        await baselinesRoute.GET(req(`/api/baselines?datasetId=${w.datasetId}&status=CONFIRMED`))
      ).json(),
    );
    expect(confirmed.items).toHaveLength(1);
    expect(confirmed.items[0]!.status).toBe('CONFIRMED');
    expect(confirmed.items[0]!.decidedBy).toBe('local');
  }, 60_000);

  it('datasetId 缺失 → 400；评测集不存在 → 404', async () => {
    const noQuery = await baselinesRoute.GET(req('/api/baselines'));
    expect(noQuery.status).toBe(400);

    const missing = await baselinesRoute.GET(
      req('/api/baselines?datasetId=00000000-0000-4000-8000-000000000000'),
    );
    expect(missing.status).toBe(404);
  });
});
