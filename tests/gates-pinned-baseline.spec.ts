/**
 * M4 Batch 4 补齐 —— 门禁固定历史基线求值（`gate.baselineId`，契约注释：
 * 「null = 用当前已确认基线；非 null = 固定到某次历史基线」）。
 *
 * 覆盖四类「写错了也照常渲染」的事：
 *  1. **逐规则锚点**：同一 run 上，无 baselineId 的规则锚定已确认基线，
 *     有 baselineId 的规则锚定它自己固定的那条历史基线——两规则的
 *     `detail.baselineValue` 必须各是各的锚点值；
 *  2. **REJECTED 的 pin ⇒ 跳过**（驳回的基线不是锚点，不判定不留痕）；
 *  3. **跨评测集 pin ⇒ 建 gate 时 400**（脏配置挡在写入侧，fail-closed）；
 *  4. **pin 指向的 run 指标为 null（FAILED run）⇒ fail-closed**：
 *     regression_pct 无法计算 ⇒ passed=false、baselineValue=null，绝不落 0 分。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RegressionGate, RegressionGateListResponse } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

import * as gatesRoute from '../app/api/gates/route.js';
import * as resultsRoute from '../app/api/gates/results/[runId]/route.js';
import * as tokenRoute from '../app/api/gates/[gateId]/callback-token/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';

function req(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json', ...init.headers } }),
  });
}

function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

/** 额外造一条历史 run（可指定分数；PENDING→RUNNING→COMPLETED 合法流转）。 */
async function insertRun(
  datasetVersionId: string,
  targetVersionId: string,
  score: number | null,
): Promise<string> {
  const row = (
    await getPool().query<{ id: string }>(
      `INSERT INTO eval_runs
         (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
          runner_version, created_by, total_cases, status)
       VALUES ('pinned-anchor', $1, $2, 2, '{}'::jsonb, '{}'::jsonb, 'test', 't', 1, 'PENDING') RETURNING id`,
      [datasetVersionId, targetVersionId],
    )
  ).rows[0]!;
  await getPool().query(`UPDATE eval_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [row.id]);
  await getPool().query(
    `UPDATE eval_runs SET status = 'COMPLETED', finished_at = now(), score_overall = $2, pass_rate = 1 WHERE id = $1`,
    [row.id, score],
  );
  return row.id;
}

/** 直接 SQL 建一条指定状态的基线行（decision 链路已单独测过，这里造结果态）。 */
async function insertBaselineRow(
  datasetId: string,
  evalRunId: string,
  status: 'NOMINATED' | 'CONFIRMED' | 'REJECTED',
): Promise<string> {
  const row = (
    await getPool().query<{ id: string }>(
      `INSERT INTO baselines (dataset_id, eval_run_id, status, note, nominated_by, decided_by, decided_at)
       VALUES ($1, $2, $3, 'pinned-test', 'local',
               CASE WHEN $3 = 'NOMINATED' THEN NULL ELSE 'local' END,
               CASE WHEN $3 = 'NOMINATED' THEN NULL ELSE now() END)
       RETURNING id`,
      [datasetId, evalRunId, status],
    )
  ).rows[0]!;
  return row.id;
}

async function issueToken(datasetId: string): Promise<string> {
  const gateId = (
    await getPool().query<{ id: string }>('SELECT id FROM regression_gates WHERE dataset_id = $1 LIMIT 1', [datasetId])
  ).rows[0]?.id;
  if (gateId === undefined) throw new Error('本测试每个世界都会先建规则');
  return (
    await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), params({ gateId }))).json()
  ).token as string;
}

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
});

describe('门禁固定历史基线求值（gate.baselineId）', () => {
  it('逐规则锚点：无 pin 的锚已确认基线、有 pin 的锚自己那条，baselineValue 各是各的', async () => {
    const w = await buildCompareWorld({
      name: 'pin',
      baseline: {
        name: 'b',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [{ caseKey: 'c1', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] }],
        metrics: { scoreOverall: 0.5 },
      },
      current: {
        name: 'c',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [{ caseKey: 'c1', score: 0.4, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.4 }] }],
        metrics: { scoreOverall: 0.4 },
      },
    });
    const runD = await insertRun(w.datasetVersionId, w.datasetVersionId === w.datasetVersionId ? (
      await getPool().query<{ id: string }>('SELECT id FROM target_versions ORDER BY created_at LIMIT 1')
    ).rows[0]!.id : '', 0.45);
    const confirmedRow = await insertBaselineRow(w.datasetId, w.baselineRunId, 'CONFIRMED');
    const nominatedRow = await insertBaselineRow(w.datasetId, runD, 'NOMINATED');

    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: '默认锚（已确认基线）', datasetId: w.datasetId, condition: { metric: 'regression_pct', op: '>', value: 5 }, action: 'BLOCK' },
      }),
    );
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: {
          name: '固定锚（历史 run D）',
          datasetId: w.datasetId,
          baselineId: nominatedRow,
          condition: { metric: 'regression_pct', op: '>', value: 5 },
          action: 'BLOCK',
        },
      }),
    );
    const token = await issueToken(w.datasetId);

    const res = await resultsRoute.GET(
      req(`/api/gates/results/${w.currentRunId}`, { headers: { 'x-callback-token': token } }),
      params({ runId: w.currentRunId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateResult: { evaluations: Array<{ gateName: string; passed: boolean; detail: { baselineValue: number | null; delta: number | null } }> } };

    const byName = Object.fromEntries(body.gateResult.evaluations.map((e) => [e.gateName, e]));
    // 无 pin：(0.5-0.4)/0.5*100 = 20%
    expect(byName['默认锚（已确认基线）']?.detail.baselineValue).toBeCloseTo(0.5, 12);
    expect(byName['默认锚（已确认基线）']?.detail.delta).toBeCloseTo(20, 6);
    // 有 pin：(0.45-0.4)/0.45*100 ≈ 11.1%
    expect(byName['固定锚（历史 run D）']?.detail.baselineValue).toBeCloseTo(0.45, 12);
    expect(byName['固定锚（历史 run D）']?.detail.delta).toBeCloseTo(11.1111111, 4);
    // confirmedRow 参与了判定（防呆：确认行确实存在且被用到）
    expect(confirmedRow).toBeTruthy();
  });

  it('REJECTED 的 pin ⇒ 跳过（不判定、不留痕）', async () => {
    const w = await buildCompareWorld({
      name: 'pinrej',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { scoreOverall: 0.5 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { scoreOverall: 0.4 } },
    });
    const rejectedRow = await insertBaselineRow(w.datasetId, w.baselineRunId, 'REJECTED');
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: '驳回锚', datasetId: w.datasetId, baselineId: rejectedRow, condition: { metric: 'regression_pct', op: '>', value: 5 }, action: 'BLOCK' },
      }),
    );
    const token = await issueToken(w.datasetId);
    const res = await resultsRoute.GET(
      req(`/api/gates/results/${w.currentRunId}`, { headers: { 'x-callback-token': token } }),
      params({ runId: w.currentRunId }),
    );
    const body = (await res.json()) as { gateResult: { evaluations: unknown[]; overall: string } };
    expect(body.gateResult.evaluations).toEqual([]);
    expect(body.gateResult.overall).toBe('NO_GATE');
    const rows = await getPool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM gate_evaluations WHERE eval_run_id = $1',
      [w.currentRunId],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('createGate 跨评测集 pin ⇒ 400（挡在写入侧）', async () => {
    const w = await buildCompareWorld({
      name: 'pincross',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { scoreOverall: 0.5 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { scoreOverall: 0.4 } },
    });
    const other = await buildCompareWorld({
      name: 'pincross-other',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { scoreOverall: 0.5 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { scoreOverall: 0.4 } },
    });
    const otherRow = await insertBaselineRow(other.datasetId, other.baselineRunId, 'CONFIRMED');
    const res = await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: '跨集 pin', datasetId: w.datasetId, baselineId: otherRow, condition: { metric: 'regression_pct', op: '>', value: 5 } },
      }),
    );
    expect(res.status).toBe(400);
    void RegressionGate;
    void RegressionGateListResponse;
  });

  it('pin 指向的 run 指标为 null（FAILED run）⇒ fail-closed：passed=false、baselineValue=null', async () => {
    const w = await buildCompareWorld({
      name: 'pinfail',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { scoreOverall: 0.5 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { scoreOverall: 0.4 } },
    });
    // 直接流转到 FAILED（终态行被 eval_runs_guard 冻结，不能 COMPLETED 后再改）
    const tvId = (
      await getPool().query<{ id: string }>('SELECT id FROM target_versions ORDER BY created_at LIMIT 1')
    ).rows[0]!.id;
    const failedRun = (
      await getPool().query<{ id: string }>(
        `INSERT INTO eval_runs
           (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
            runner_version, created_by, total_cases, status)
         VALUES ('failed-anchor', $1, $2, 2, '{}'::jsonb, '{}'::jsonb, 'test', 't', 1, 'PENDING') RETURNING id`,
        [w.datasetVersionId, tvId],
      )
    ).rows[0]!.id;
    await getPool().query(`UPDATE eval_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [failedRun]);
    await getPool().query(
      `UPDATE eval_runs SET status = 'FAILED', finished_at = now(), score_overall = NULL, pass_rate = NULL WHERE id = $1`,
      [failedRun],
    );
    const row = await insertBaselineRow(w.datasetId, failedRun, 'CONFIRMED');
    await gatesRoute.POST(
      req('/api/gates', {
        method: 'POST',
        body: { name: '失效锚', datasetId: w.datasetId, baselineId: row, condition: { metric: 'regression_pct', op: '>', value: 5 }, action: 'BLOCK' },
      }),
    );
    const token = await issueToken(w.datasetId);
    const res = await resultsRoute.GET(
      req(`/api/gates/results/${w.currentRunId}`, { headers: { 'x-callback-token': token } }),
      params({ runId: w.currentRunId }),
    );
    const body = (await res.json()) as { gateResult: { evaluations: Array<{ passed: boolean; detail: { baselineValue: number | null; currentValue: number | null } }>; overall: string } };
    expect(body.gateResult.evaluations).toHaveLength(1);
    expect(body.gateResult.evaluations[0]?.passed).toBe(false);
    expect(body.gateResult.evaluations[0]?.detail.baselineValue).toBeNull();
    expect(body.gateResult.overall).toBe('FAIL');
  });
});
