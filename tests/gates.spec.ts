/**
 * M4 Batch 2 —— 门禁规则 CRUD 与判定引擎（`US-017` 数据面，`BL-2`）。
 *
 * 依据：`contracts/src/gate.ts`（形状唯一事实源）、`contracts/src/api.ts`
 * `GateResultResponse`、`db/migrations/0013/0014`（留痕不可变 `reject_mutation`）、
 * `docs/Spec/SPEC-M4.md` §2 Batch 2（九项裁定已回填：Q1=C 拉取模式、Q3=三级
 * 仅展示标签复用 GateCondition、Q5=US-019 四维、Q6=PG-10）。
 *
 * 判定语义（fail-closed，与 OPEN-5 / BL-2 一致）：
 *  - 指标值为 null（FAILED run / 未设阈值）⇒ passed=false（不放行，不落 0 分）；
 *  - `regression_pct` 相对**已确认基线**；无确认基线 ⇒ 该规则跳过不判定；
 *  - WARN 触发 ⇒ 留痕 passed=false 但 overall=PASS（WARN 只告警不阻断）；
 *  - 幂等：同 (gate, run) 重复求值不重复留痕。
 *
 * 与 api.spec.ts 同法：真库不 mock，直调 Route Handler 导出。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GateResultResponse, RegressionGate, RegressionGateListResponse } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld, type CompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

import * as gatesRoute from '../app/api/gates/route.js';
import * as gateIdRoute from '../app/api/gates/[gateId]/route.js';
import * as resultsRoute from '../app/api/gates/results/[runId]/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
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

/** 标准世界：基线 0.5 / 当前 0.4（同版本两 run，均 COMPLETED，可判定 L1/L3）。 */
async function worldWithScores(): Promise<CompareWorld> {
  return buildCompareWorld({
    name: 'gates',
    baseline: {
      name: 'baseline',
      evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
      cases: [
        { caseKey: 'c1', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] },
        { caseKey: 'c2', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] },
      ],
      metrics: { scoreOverall: 0.5, passRate: 1, coverage: 1 },
    },
    current: {
      name: 'current',
      evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
      cases: [
        { caseKey: 'c1', score: 0.4, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.4 }] },
        { caseKey: 'c2', score: 0.4, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.4 }] },
      ],
      metrics: { scoreOverall: 0.4, passRate: 1, coverage: 1 },
    },
  });
}

/** 直接经 SQL 确认基线（Batch 1 的 decision 链路已在 API 层测过，这里只造结果态）。 */
async function confirmBaseline(datasetId: string, evalRunId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO baselines (dataset_id, eval_run_id, status, note, nominated_by, decided_by, decided_at)
     VALUES ($1, $2, 'CONFIRMED', 'gates-test', 'local', 'local', now())`,
    [datasetId, evalRunId],
  );
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
// 门禁规则 CRUD（POST/GET/PATCH /api/gates）
// ---------------------------------------------------------------------------

describe('门禁规则 CRUD（US-017 数据面）', () => {
  it('POST → 201 + RegressionGate 契约形状（created_by 为 MVP 单机标识 local）', async () => {
    const w = await worldWithScores();
    const res = await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'P0 评测集得分红线',
          datasetId: w.datasetId,
          condition: { metric: 'score_overall', op: '<', value: 0.85 },
          action: 'BLOCK',
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = RegressionGate.parse(await res.json());
    expect(body.name).toBe('P0 评测集得分红线');
    expect(body.action).toBe('BLOCK');
    expect(body.isActive).toBe(true);
    expect(body.createdBy).toBe('local');
  });

  it('GET ?datasetId= → 仅返回该评测集的规则', async () => {
    const w = await worldWithScores();
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'r1',
          datasetId: w.datasetId,
          condition: { metric: 'score_overall', op: '<', value: 0.85 },
        },
      }),
    );
    const res = await gatesRoute.GET(req(`/api/gates?datasetId=${w.datasetId}`));
    expect(res.status).toBe(200);
    const body = RegressionGateListResponse.parse(await res.json());
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.datasetId).toBe(w.datasetId);
  });

  it('PATCH 更新 name / condition / isActive → 200 + updated_at 前进', async () => {
    const w = await worldWithScores();
    const created = RegressionGate.parse(
      await (
        await gatesRoute.POST(
          req('/api/gates', {
            method: 'POST',
            body: {
              name: 'r1',
              datasetId: w.datasetId,
              condition: { metric: 'score_overall', op: '<', value: 0.85 },
            },
          }),
        )
      ).json(),
    );
    const res = await gateIdRoute.PATCH(
      req('/api/gates', {
        method: 'PATCH',
        body: { name: '改名后的规则', action: 'WARN' },
      }),
      params({ gateId: created.id }),
    );
    expect(res.status).toBe(200);
    const body = RegressionGate.parse(await res.json());
    expect(body.name).toBe('改名后的规则');
    expect(body.action).toBe('WARN');
    expect(body.condition).toMatchObject({ metric: 'score_overall', op: '<', value: 0.85 });
  });

  it('PATCH 未知 gateId → 404；非法 body（regression_pct 负值）→ 400', async () => {
    const missing = await gateIdRoute.PATCH(
      req('/api/gates', { method: 'PATCH', body: { name: 'x' } }),
      params({ gateId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(missing.status).toBe(404);

    const w = await worldWithScores();
    const bad = await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'bad',
          datasetId: w.datasetId,
          condition: { metric: 'regression_pct', op: '>', value: -5 },
        },
      }),
    );
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 判定引擎（跑批终态 → 逐规则求值 → 留痕 → GateResultEnvelope）
// ---------------------------------------------------------------------------

describe('GET /api/gates/results/{runId} · 判定引擎（Q3：三级=标签，复用 GateCondition）', () => {
  it('L1 红线 BLOCK 触发 → overall=FAIL + gate_evaluations 留痕 + 幂等不重复', async () => {
    const w = await worldWithScores();
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'L1 得分红线',
          datasetId: w.datasetId,
          condition: { metric: 'score_overall', op: '<', value: 0.85 },
          action: 'BLOCK',
        },
      }),
    );
    const res = await resultsRoute.GET(req(`/api/gates/results/${w.currentRunId}`), params({ runId: w.currentRunId }));
    expect(res.status).toBe(200);
    const body = GateResultResponse.parse(await res.json());
    expect(body.gateResult.overall).toBe('FAIL');
    expect(body.gateResult.evaluations).toHaveLength(1);
    expect(body.gateResult.evaluations[0]?.passed).toBe(false);
    expect(body.gateResult.evaluations[0]?.detail).toMatchObject({
      metric: 'score_overall',
      op: '<',
      value: 0.85,
    });

    // 留痕落库
    const rows = await getPool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM gate_evaluations WHERE eval_run_id = $1',
      [w.currentRunId],
    );
    expect(rows.rows[0]?.count).toBe('1');

    // 幂等：重复求值不重复留痕
    await resultsRoute.GET(req(`/api/gates/results/${w.currentRunId}`), params({ runId: w.currentRunId }));
    const rows2 = await getPool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM gate_evaluations WHERE eval_run_id = $1',
      [w.currentRunId],
    );
    expect(rows2.rows[0]?.count).toBe('1');
  });

  it('无规则 → NO_GATE', async () => {
    const w = await worldWithScores();
    const res = await resultsRoute.GET(req(`/api/gates/results/${w.currentRunId}`), params({ runId: w.currentRunId }));
    const body = GateResultResponse.parse(await res.json());
    expect(body.gateResult.overall).toBe('NO_GATE');
    expect(body.gateResult.evaluations).toEqual([]);
  });

  it('L2 水位 WARN：触发 → passed=false 但 overall=PASS（WARN 不阻断）', async () => {
    const w = await worldWithScores();
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'L2 得分水位（仅告警）',
          datasetId: w.datasetId,
          condition: { metric: 'score_overall', op: '<', value: 0.85 },
          action: 'WARN',
        },
      }),
    );
    const res = await resultsRoute.GET(req(`/api/gates/results/${w.currentRunId}`), params({ runId: w.currentRunId }));
    const body = GateResultResponse.parse(await res.json());
    expect(body.gateResult.overall).toBe('PASS');
    expect(body.gateResult.evaluations[0]?.passed).toBe(false);
    expect(body.gateResult.evaluations[0]?.detail.metric).toBe('score_overall');
  });

  it('L3 退化：regression_pct > 5（相对已确认基线）→ FAIL；delta 计算正确', async () => {
    const w = await worldWithScores();
    await confirmBaseline(w.datasetId, w.baselineRunId);
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'L3 退化阈值',
          datasetId: w.datasetId,
          condition: { metric: 'regression_pct', op: '>', value: 5 },
          action: 'BLOCK',
        },
      }),
    );
    const res = await resultsRoute.GET(req(`/api/gates/results/${w.currentRunId}`), params({ runId: w.currentRunId }));
    const body = GateResultResponse.parse(await res.json());
    expect(body.gateResult.overall).toBe('FAIL');
    const detail = body.gateResult.evaluations[0]?.detail;
    expect(detail, 'L3 判定必须留痕').toBeDefined();
    expect(detail?.metric).toBe('regression_pct');
    expect(detail?.baselineValue).toBeCloseTo(0.5, 12);
    expect(detail?.currentValue).toBeCloseTo(0.4, 12);
    // (0.5 - 0.4) / 0.5 * 100 = 20（百分点），> 5 ⇒ 触发
    expect(detail?.delta).toBeCloseTo(20, 10);
  });

  it('无已确认基线时 regression_pct 规则跳过（不判定、不留痕）', async () => {
    const w = await worldWithScores();
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'L3 无基线场景',
          datasetId: w.datasetId,
          condition: { metric: 'regression_pct', op: '>', value: 5 },
          action: 'BLOCK',
        },
      }),
    );
    const res = await resultsRoute.GET(req(`/api/gates/results/${w.currentRunId}`), params({ runId: w.currentRunId }));
    const body = GateResultResponse.parse(await res.json());
    expect(body.gateResult.evaluations).toEqual([]);
    expect(body.gateResult.overall).toBe('NO_GATE');
    expect(body.gateResult.baseline).toBeNull();
  });

  it('留痕不可变：UPDATE gate_evaluations → 409（reject_mutation）', async () => {
    const w = await worldWithScores();
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: 'L1',
          datasetId: w.datasetId,
          condition: { metric: 'score_overall', op: '<', value: 0.85 },
          action: 'BLOCK',
        },
      }),
    );
    await resultsRoute.GET(req(`/api/gates/results/${w.currentRunId}`), params({ runId: w.currentRunId }));
    await expect(
      getPool().query(`UPDATE gate_evaluations SET passed = true WHERE eval_run_id = $1`, [w.currentRunId]),
    ).rejects.toThrow(/immutable|拒|无法/i);
  });

  it('未知 runId → 404', async () => {
    const res = await resultsRoute.GET(
      req('/api/gates/results/00000000-0000-4000-8000-000000000000'),
      params({ runId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(res.status).toBe(404);
  });
});
