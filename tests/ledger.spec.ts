/**
 * M4 Batch 4 —— 成本台账聚合（`US-019` 四维 + fixture 排除，`BE-M4-08`）。
 *
 * 覆盖三类「写错了也照常渲染」的事：
 *  1. 四维聚合与 `eval_runs.cost_total` 逐行求和**误差 0**（G5；numeric 精确 SUM，
 *     node 侧绝不浮点累加——TS-2 红线）；
 *  2. fixture provider 行必须排除（milestones §5.3 台账口径红线）；
 *  3. T2 端点未回传 usage 的 case 计入 `unknownCostCases`（US-021：成本记 unknown，
 *     不得用 0 冒充「真实零成本」）。
 *
 * 与 gates.spec 同法：真库不 mock，直调 Route Handler 导出。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CostLedgerResponse } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';
import { FIXTURE_PROVIDER } from '../db/seed/fixture-provider.js';

import * as ledgerRoute from '../app/api/ledger/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';
const FROM = '2026-11-01T00:00:00Z';
const TO = '2026-11-30T23:59:59Z';

function req(query: string): NextRequest {
  return new NextRequest(`${BASE}/api/ledger?${query}`);
}

/** PENDING → RUNNING → COMPLETED 全列可控的 run 行（guard 只拦终态后 UPDATE，INSERT 自由）。 */
async function insertRun(spec: {
  datasetVersionId: string;
  targetVersionId: string;
  createdBy?: string;
  costTarget?: number;
  costJudge?: number;
  tokensIn?: number;
  tokensOut?: number;
  createdAt?: string;
  name?: string;
}): Promise<string> {
  const one = async (text: string, params: unknown[]): Promise<string> => {
    const row = (await getPool().query<{ id: string }>(text, params)).rows[0];
    if (!row) throw new Error(`夹具期望一行：${text}`);
    return row.id;
  };
  const runId = await one(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status, created_at)
     VALUES ($1, $2, $3, 4, '{}'::jsonb, '{}'::jsonb, 'test', $4, 0, 'PENDING',
             COALESCE($5::timestamptz, now())) RETURNING id`,
    [spec.name ?? 'ledger-run', spec.datasetVersionId, spec.targetVersionId, spec.createdBy ?? 't', spec.createdAt ?? null],
  );
  await getPool().query(`UPDATE eval_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [runId]);
  await getPool().query(
    `UPDATE eval_runs SET status = 'COMPLETED', finished_at = now(),
            tokens_in_total = $2, tokens_out_total = $3, cost_target = $4, cost_judge = $5
      WHERE id = $1`,
    [runId, spec.tokensIn ?? 0, spec.tokensOut ?? 0, spec.costTarget ?? 0, spec.costJudge ?? 0],
  );
  return runId;
}

/** 独立复算：窗口内（排除 fixture）的 eval_runs.cost_total 逐行求和——G5 的标准答案。 */
async function sqlWindowSum(): Promise<{ costTotal: string; costJudge: string; costTarget: string; runs: string }> {
  const res = await getPool().query<{
    cost_total: string;
    cost_judge: string;
    cost_target: string;
    runs: string;
  }>(
    `SELECT COALESCE(SUM(r.cost_total), 0)::text AS cost_total,
            COALESCE(SUM(r.cost_judge), 0)::text AS cost_judge,
            COALESCE(SUM(r.cost_target), 0)::text AS cost_target,
            COUNT(*)::text AS runs
       FROM eval_runs r
       JOIN target_versions tv ON tv.id = r.target_version_id
       LEFT JOIN model_providers p ON p.id = tv.model_provider_id
      WHERE r.created_at >= $1::timestamptz AND r.created_at <= $2::timestamptz
        AND (p.id IS NULL OR p.name <> $3)`,
    [FROM, TO, FIXTURE_PROVIDER.name],
  );
  const row = res.rows[0]!;
  return { costTotal: row.cost_total, costJudge: row.cost_judge, costTarget: row.cost_target, runs: row.runs };
}

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
});

describe('GET /api/ledger · 成本台账聚合（US-019 四维）', () => {
  it('model 维：分组、OPEN-3 分列、与 eval_runs.cost_total 逐行求和误差 0（G5）', async () => {
    const w = await buildCompareWorld({
      name: 'led',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { costTarget: 1.5 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { costTarget: 2 } },
    });
    // 第三条 run：换发起人 + judge 费用 + tokens（同模型/同评测集）
    await insertRun({
      datasetVersionId: w.datasetVersionId,
      targetVersionId: (await getPool().query<{ id: string }>('SELECT id FROM target_versions LIMIT 1')).rows[0]!.id,
      createdBy: 'other',
      costTarget: 0.25,
      costJudge: 0.5,
      tokensIn: 1000,
      tokensOut: 200,
    });

    const res = await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=model`));
    expect(res.status).toBe(200);
    const body = CostLedgerResponse.parse(await res.json());

    const oracle = await sqlWindowSum();
    // G5：台账汇总 = DB 逐行求和，误差 0
    expect(body.summary.costTotal).toBe(Number(oracle.costTotal));
    expect(body.summary.costJudge).toBe(Number(oracle.costJudge));
    expect(body.summary.costTarget).toBe(Number(oracle.costTarget));
    expect(body.summary.runCount).toBe(Number(oracle.runs));
    expect(body.summary.tokensIn).toBe(1000);
    expect(body.summary.tokensOut).toBe(200);
    expect(body.summary.unknownCostCases).toBe(0);

    // 三条 run 同模型 ⇒ 一行，costTotal 与 summary 一致
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.dimensionKey).toBe('fixture-echo-1');
    expect(body.items[0]?.runCount).toBe(3);
    expect(body.items[0]?.costTotal).toBe(body.summary.costTotal);
    expect(body.items[0]?.costJudge).toBe(0.5);
  });

  it('dataset 维：key=评测集 id、label=评测集名；user 维：按发起人分组', async () => {
    const w = await buildCompareWorld({
      name: 'ledd',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { costTarget: 1 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { costTarget: 2 } },
    });

    const byDataset = CostLedgerResponse.parse(
      await (await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=dataset`))).json(),
    );
    expect(byDataset.items).toHaveLength(1);
    expect(byDataset.items[0]?.dimensionKey).toBe(w.datasetId);
    expect(byDataset.items[0]?.label).toBe('cmp-ledd');

    const byUser = CostLedgerResponse.parse(
      await (await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=user`))).json(),
    );
    expect(byUser.items).toHaveLength(1); // buildCompareWorld 的 run 全部 created_by='t'
    expect(byUser.items[0]?.dimensionKey).toBe('t');
  });

  it('time 维：按 UTC 日分桶（不同日期的 run 分行）', async () => {
    const w = await buildCompareWorld({
      name: 'ledt',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { costTarget: 1 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { costTarget: 1 } },
    });
    const tvId = (await getPool().query<{ id: string }>('SELECT id FROM target_versions LIMIT 1')).rows[0]!.id;
    await insertRun({
      datasetVersionId: w.datasetVersionId,
      targetVersionId: tvId,
      costTarget: 3,
      createdAt: '2026-11-05T10:00:00Z',
    });

    const body = CostLedgerResponse.parse(
      await (await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=time`))).json(),
    );
    expect(body.items).toHaveLength(2);
    const keys = body.items.map((r) => r.dimensionKey).sort();
    expect(keys[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(keys).toContain('2026-11-05');
  });

  it('fixture provider 行必须排除（milestones §5.3 台账口径红线）', async () => {
    const w = await buildCompareWorld({
      name: 'ledf',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { costTarget: 2 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { costTarget: 2 } },
    });
    // 与种子同名（身份判定）的 fixture provider + 一条挂着它的 run（cost=9.99 假钱）
    const one = async (text: string, params: unknown[]): Promise<string> => {
      const row = (await getPool().query<{ id: string }>(text, params)).rows[0];
      if (!row) throw new Error(`夹具期望一行：${text}`);
      return row.id;
    };
    const fixtureProviderId = await one(
      `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked, is_active)
       VALUES ($1, 'openai_compatible', 'http://127.0.0.1:8787', 'fixture-noop', 'fixture-••••noop', false)
       RETURNING id`,
      [FIXTURE_PROVIDER.name],
    );
    const fixtureTargetId = await one(
      `INSERT INTO targets (name, kind, current_version_no, owner_id) VALUES ('tg-fix', 't1_prompt', 1, 't') RETURNING id`,
      [],
    );
    const fixtureTvId = await one(
      `INSERT INTO target_versions
         (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
       VALUES ($1, 1, 't1_prompt', $2, 'fixture-echo-1', '{{input}}', 0, 64, 't') RETURNING id`,
      [fixtureTargetId, fixtureProviderId],
    );
    await insertRun({
      datasetVersionId: w.datasetVersionId,
      targetVersionId: fixtureTvId,
      costTarget: 9.99,
      name: 'fixture-run',
    });

    const body = CostLedgerResponse.parse(
      await (await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=model`))).json(),
    );
    // 假钱不进台账：只有真实 provider 的 4（2+2）
    expect(body.summary.costTotal).toBe(4);
    expect(body.items.map((r) => r.runCount)).not.toContain(1);
    const oracle = await sqlWindowSum();
    expect(body.summary.costTotal).toBe(Number(oracle.costTotal));
  });

  it('T2 run 无 usage ⇒ unknownCostCases 暴露（成本按 0 计入但语义是 unknown，US-021）', async () => {
    const w = await buildCompareWorld({
      name: 'ledu',
      baseline: { name: 'b', evaluators: [], cases: [] },
      current: { name: 'c', evaluators: [], cases: [{ caseKey: 'c1', score: 0.5 }] },
    });
    const one = async (text: string, params: unknown[]): Promise<string> => {
      const row = (await getPool().query<{ id: string }>(text, params)).rows[0];
      if (!row) throw new Error(`夹具期望一行：${text}`);
      return row.id;
    };
    const t2TargetId = await one(
      `INSERT INTO targets (name, kind, current_version_no, owner_id) VALUES ('tg-t2', 't2_http', 1, 't') RETURNING id`,
      [],
    );
    const t2TvId = await one(
      `INSERT INTO target_versions
         (target_id, version_no, kind, endpoint_url, request_mapping, response_mapping, created_by)
       VALUES ($1, 1, 't2_http', 'http://127.0.0.1:1/hook', '{"q":"case.input"}'::jsonb, '{"answer":"answer"}'::jsonb, 't')
       RETURNING id`,
      [t2TargetId],
    );
    const t2RunId = await insertRun({
      datasetVersionId: w.datasetVersionId,
      targetVersionId: t2TvId,
      costTarget: 0,
      name: 't2-run',
    });
    const caseId = (
      await getPool().query<{ id: string }>('SELECT id FROM dataset_cases WHERE dataset_version_id = $1 LIMIT 1', [
        w.datasetVersionId,
      ])
    ).rows[0]!.id;
    await getPool().query(
      `INSERT INTO eval_case_results
         (eval_run_id, dataset_case_id, case_key, output_text, status, score, tokens_in, tokens_out, cost_target)
       VALUES ($1, $2, 'c1', 'ok', 'OK', 0.9, 0, 0, 0)`,
      [t2RunId, caseId],
    );

    const body = CostLedgerResponse.parse(
      await (await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=model`))).json(),
    );
    expect(body.summary.unknownCostCases).toBe(1);
    // unknown 行归属到「外部目标」分组，而不是混进某个模型
    expect(body.items.map((r) => r.unknownCostCases)).toContain(1);
  });

  it('窗外 run 不进；缺 from/to → 400；非法 dimension → 400', async () => {
    const w = await buildCompareWorld({
      name: 'ledw',
      baseline: { name: 'b', evaluators: [], cases: [], metrics: { costTarget: 1 } },
      current: { name: 'c', evaluators: [], cases: [], metrics: { costTarget: 1 } },
    });
    const tvId = (await getPool().query<{ id: string }>('SELECT id FROM target_versions LIMIT 1')).rows[0]!.id;
    await insertRun({
      datasetVersionId: w.datasetVersionId,
      targetVersionId: tvId,
      costTarget: 7,
      createdAt: '2026-10-15T10:00:00Z',
    });

    const body = CostLedgerResponse.parse(
      await (await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=model`))).json(),
    );
    expect(body.summary.costTotal).toBe(2); // 10 月的 7 不进 11 月窗口

    const missing = await ledgerRoute.GET(req('dimension=model'));
    expect(missing.status).toBe(400);
    const badDim = await ledgerRoute.GET(req(`from=${FROM}&to=${TO}&dimension=project`));
    expect(badDim.status).toBe(400);
  });
});
