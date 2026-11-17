/**
 * M3 · Batch 2 —— `GET /api/compare`（汇总对比 + 逐条对比，`US-009`，`PG-08`）。
 *
 * 依据：`contracts/src/api.ts` `CompareQuery` / `CompareResponse`、
 * `contracts/src/eval-contracts.ts` `describeIncomparable()`（硬拒绝维度穷举：仅
 * datasetVersionId 不同与同 run 自比，非空 → **400**，openapi「否则返回 400」，
 * 不用 409）、`verdictOf()`（严格大于阈值；缺侧 NOT_COMPARABLE 不落 0 分）。
 * 实现前提四项裁定（2026-11-15，正文见 SPEC-M3 §2 Batch 2）：deltaPct 除零/空 → null；
 * 算子并集 baseline 序优先；分页少做（page={nextCursor:null,total}）；null 指标透传。
 *
 * 与 `api.spec.ts` 同法：真库不 mock，直调 Route Handler 导出。
 * 夹具：`tests/support/compare-fixtures.ts`（buildCompareWorld）。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CompareResponse,
  describeIncomparable,
} from '@eval-platform/contracts';
import type { EvalRun } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld, insertConfirmedBaseline } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

// Route Handler（RED：本模块尚不存在）
import * as compareRoute from '../app/api/compare/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';

function req(path: string): NextRequest {
  return new NextRequest(`${BASE}${path}`);
}

/** 断言前的键提取：缺键直接炸，避免 `undefined` 混进断言让失败信息失真。 */
function must<T>(v: T | undefined, k: string): T {
  if (v === undefined) throw new Error(`断言键缺失：${k}`);
  return v;
}

const BANNER = '尚未确认基线，本次对比仅供观察，不作为门禁依据';

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
});

// ---------------------------------------------------------------------------
// A · 硬拒绝（describeIncomparable 契约穷举，期望字符串直接取自契约函数）
// ---------------------------------------------------------------------------

describe('GET /api/compare · 硬拒绝（describeIncomparable → 400）', () => {
  it('A1 两 run 的 datasetVersionId 不同 → 400，报错含契约函数返回原文', async () => {
    const w1 = await buildCompareWorld({ name: 'a1-x', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });
    const w2 = await buildCompareWorld({ name: 'a1-y', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });

    const expected = describeIncomparable(
      { id: w1.baselineRunId, datasetVersionId: w1.datasetVersionId } as unknown as EvalRun,
      { id: w2.currentRunId, datasetVersionId: w2.datasetVersionId } as unknown as EvalRun,
    );
    expect(expected).not.toBeNull();

    const res = await compareRoute.GET(req(`/api/compare?baselineRunId=${w1.baselineRunId}&currentRunId=${w2.currentRunId}`));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(expected);
  });

  it('A2 baselineRunId === currentRunId → 400，报错含契约函数返回原文', async () => {
    const w = await buildCompareWorld({ name: 'a2', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });

    const expected = describeIncomparable(
      { id: w.baselineRunId, datasetVersionId: w.datasetVersionId } as unknown as EvalRun,
      { id: w.baselineRunId, datasetVersionId: w.datasetVersionId } as unknown as EvalRun,
    );
    expect(expected).not.toBeNull();

    const res = await compareRoute.GET(req(`/api/compare?baselineRunId=${w.baselineRunId}&currentRunId=${w.baselineRunId}`));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(expected);
  });
});

// ---------------------------------------------------------------------------
// B · happy path 与数据准确性
// ---------------------------------------------------------------------------

/** 标准世界：c1 改善(+0.25)、c2 持平(0)、c3 当前侧 FAILED（NOT_COMPARABLE）。 */
async function happyWorld() {
  return buildCompareWorld({
    name: 'happy',
    baseline: {
      name: 'baseline',
      evaluators: [
        { key: 'recall_at_k', kind: 'rule', orderIndex: 0 },
        { key: 'json_schema', kind: 'rule', orderIndex: 1 },
      ],
      cases: [
        { caseKey: 'c1', score: 0.5, operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.5 }, { key: 'json_schema', kind: 'rule', score: 0.5 } ] },
        { caseKey: 'c2', score: 0.9, operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.9 }, { key: 'json_schema', kind: 'rule', score: 0.9 } ] },
        { caseKey: 'c3', score: 0.25, operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.25 }, { key: 'json_schema', kind: 'rule', score: 0.25 } ] },
      ],
      metrics: { scoreOverall: 0.55, passRate: null, coverage: 1, latencyP50: 100, latencyP95: 200, costTarget: 0 },
    },
    current: {
      name: 'current',
      evaluators: [
        { key: 'recall_at_k', kind: 'rule', orderIndex: 0 },
        { key: 'json_schema', kind: 'rule', orderIndex: 1 },
      ],
      cases: [
        { caseKey: 'c1', score: 0.75, operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.75 }, { key: 'json_schema', kind: 'rule', score: 0.75 } ] },
        { caseKey: 'c2', score: 0.9, operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.9 }, { key: 'json_schema', kind: 'rule', score: 0.9 } ] },
        { caseKey: 'c3', status: 'FAILED' },
      ],
      metrics: { scoreOverall: 0.825, passRate: 0.5, coverage: null, latencyP50: 150, latencyP95: 250, costTarget: 2 },
    },
  });
}

describe('GET /api/compare · happy path 与数据准确性', () => {
  it('B5 metrics 六行齐全：值、higherIsBetter、null 侧 delta=null、baseline=0 时 deltaPct=null（Q1/Q4）', async () => {
    const w = await happyWorld();
    const res = await compareRoute.GET(req(`/api/compare?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}`));
    expect(res.status).toBe(200);
    const body = CompareResponse.parse(await res.json());

    expect(body.metrics.map((m) => m.metric)).toEqual([
      'score_overall', 'pass_rate', 'coverage', 'latency_p50_ms', 'latency_p95_ms', 'cost_total',
    ]);

    const byKey = Object.fromEntries(body.metrics.map((m) => [m.metric, m]));
    const so = must(byKey['score_overall'], 'score_overall');
    expect(so).toMatchObject({ higherIsBetter: true });
    expect(so.delta).toBeCloseTo(0.275, 12);
    expect(so.deltaPct).toBeCloseTo(0.5, 12);

    // Q4：pass_rate 基线为 null → 透传 null，delta/deltaPct 全 null
    expect(byKey['pass_rate']).toMatchObject({ baseline: null, current: 0.5, delta: null, deltaPct: null });
    // Q4：coverage 当前为 null → 透传 null
    expect(byKey['coverage']).toMatchObject({ baseline: 1, current: null, delta: null, deltaPct: null });

    // higherIsBetter：latency / cost 变大为坏
    expect(byKey['latency_p50_ms']).toMatchObject({ higherIsBetter: false, baseline: 100, current: 150 });
    expect(byKey['latency_p95_ms']).toMatchObject({ higherIsBetter: false, delta: 50 });

    // Q1：baseline=0 → deltaPct=null（绝不出现 Infinity/NaN）
    expect(byKey['cost_total']).toMatchObject({ baseline: 0, current: 2, delta: 2, deltaPct: null });
    expect(JSON.stringify(body)).not.toContain('Infinity');
    expect(JSON.stringify(body)).not.toContain('NaN');
  });

  it('B7 banner 三态：未确认 → 横幅逐字；指向已确认基线 → true+null；确认基线是别的 run → false+横幅', async () => {
    const w = await happyWorld();
    const url = `/api/compare?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}`;

    // 态一：数据集尚无任何确认基线
    const none = await compareRoute.GET(req(url));
    const noneBody = CompareResponse.parse(await none.json());
    expect(noneBody.baselineConfirmed).toBe(false);
    expect(noneBody.banner).toBe(BANNER);

    // 态二：确认基线 = 本次对比的 baselineRun
    await insertConfirmedBaseline(w.datasetId, w.baselineRunId);
    const confirmed = await compareRoute.GET(req(url));
    const confirmedBody = CompareResponse.parse(await confirmed.json());
    expect(confirmedBody.baselineConfirmed).toBe(true);
    expect(confirmedBody.banner).toBeNull();

    // 态三：确认基线存在，但指向 currentRun（每集仅一条 CONFIRMED——先清场再改指向，
    // 不能直接插第二条，ux_baselines_one_confirmed 会拦）
    await getPool().query(`DELETE FROM baselines WHERE dataset_id = $1`, [w.datasetId]);
    await insertConfirmedBaseline(w.datasetId, w.currentRunId);
    const replaced = await compareRoute.GET(req(url));
    const replacedBody = CompareResponse.parse(await replaced.json());
    expect(replacedBody.baselineConfirmed).toBe(false);
    expect(replacedBody.banner).toBe(BANNER);
  });

  it('B8 参数边界：run 不存在 → 404；缺参 / 非法 uuid → 400', async () => {
    const w = await happyWorld();
    const missing = await compareRoute.GET(
      req(`/api/compare?baselineRunId=00000000-0000-4000-8000-000000000000&currentRunId=${w.currentRunId}`),
    );
    expect(missing.status).toBe(404);

    expect(
      (await compareRoute.GET(req(`/api/compare?baselineRunId=${w.baselineRunId}`))).status,
    ).toBe(400);
    expect(
      (await compareRoute.GET(req('/api/compare?baselineRunId=not-a-uuid&currentRunId=not-a-uuid'))).status,
    ).toBe(400);
  });
});
