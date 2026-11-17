/**
 * M3 · Batch 1 —— Baseline 提名与解析（`US-013`，`BL-1`…`BL-4`）。
 *
 * 依据：`docs/Spec/SPEC-M3.md` §2 Batch 1（含「实现前提」三条裁定）、
 * `contracts/src/gate.ts`（形状唯一事实源）、`contracts/openapi.yaml` `/api/baselines*`、
 * `db/migrations/0012_baselines.sql`（`ux_baselines_one_confirmed` 部分唯一索引）。
 *
 * 与 `api.spec.ts` 同法：**真库、不 mock**，直接调 Route Handler 导出函数
 * （省掉的是 HTTP 传输层，不是被测物）；夹具走 `tests/support/fixtures.ts` 的
 * `insertPendingRun()`（dataset → version → case → provider → target → version → run 全链），
 * 并把 run 推进到 `COMPLETED` —— `pages-and-flows.md` :65/:130 规定提名入口
 * 仅对 `COMPLETED` / `PARTIAL_FAILED` 开放（裁定 3：API 层同样 fail-closed）。
 *
 * 确认 / 驳回（decision）在 `tests/baselines-decision.spec.ts`，单独整档 RED。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Baseline, BaselineResolution } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { insertPendingRun, restoreSeed, type PendingRunFixture } from './support/fixtures.js';

// Route Handlers（M3 Batch 1 新增；RED 阶段 baselines 路由尚不存在）
import * as baselinesRoute from '../app/api/baselines/route.js';
import * as resolutionRoute from '../app/api/baselines/resolution/route.js';

const DB_URL = process.env['DATABASE_URL'];

// ---------------------------------------------------------------------------
// 请求构造（与 api.spec.ts 同款小工具）
// ---------------------------------------------------------------------------

const BASE = 'http://localhost:3000';

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : {
          body: JSON.stringify(init.body),
          headers: { 'content-type': 'application/json' },
        }),
  });
}

/** 把 `insertPendingRun` 造出的 PENDING run 按状态机推进到 COMPLETED（PENDING→RUNNING→COMPLETED；`trg_eval_runs_guard` 只允许前进）。 */
async function completeRun(runId: string): Promise<void> {
  await getPool().query(`UPDATE eval_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [
    runId,
  ]);
  await getPool().query(
    `UPDATE eval_runs
        SET status = 'COMPLETED', finished_at = now(), succeeded_cases = 1, score_overall = 0.8
      WHERE id = $1`,
    [runId],
  );
}

/** 在既有夹具的**同一评测集**上再插一条 COMPLETED run（多 run 场景用）。 */
async function insertSecondCompletedRun(fx: PendingRunFixture, name: string): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1, $2, $3, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', 1, 'COMPLETED') RETURNING id`,
    [`run-${name}`, fx.datasetVersionId, fx.targetVersionId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('夹具 INSERT … RETURNING 未返回行');
  return row.id;
}

/** 直接经 SQL 确认基线（decision 路由属独立原子任务，本文件只造它的结果态）。 */
async function confirmBySql(runId: string): Promise<void> {
  await getPool().query(
    `UPDATE baselines SET status = 'CONFIRMED', decided_by = 'local', decided_at = now()
      WHERE eval_run_id = $1`,
    [runId],
  );
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  // 先关连接池再重建种子（restoreSeed 的约定：调用方必须先断开，否则 DROP SCHEMA 被占用）
  await closeDb();
  await restoreSeed(databaseUrl());
});

// ---------------------------------------------------------------------------
// US-013 · 提名（POST /api/baselines）
// ---------------------------------------------------------------------------

describe('POST /api/baselines · 提名（US-013，ROLE-A）', () => {
  it('合法提名 → 201，返回契约 Baseline，status=NOMINATED，nominatedBy 非空', async () => {
    const fx = await insertPendingRun('nominate-ok');
    await completeRun(fx.runId);

    const res = await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: fx.datasetId, evalRunId: fx.runId, note: '跑分稳定，提名复核' },
      }),
    );

    expect(res.status).toBe(201);
    const body = Baseline.parse(await res.json());
    expect(body.status).toBe('NOMINATED');
    expect(body.datasetId).toBe(fx.datasetId);
    expect(body.evalRunId).toBe(fx.runId);
    expect(body.note).toBe('跑分稳定，提名复核');
    expect(body.nominatedBy).toBe('local'); // 裁定 2：MVP 固定单机标识
    expect(body.decidedBy).toBeNull();
    expect(body.decidedAt).toBeNull();
  });

  it('请求体缺 note 或非法 uuid → 400 ValidationFailed（契约 parse 挡在仓储之前）', async () => {
    const fx = await insertPendingRun('nominate-bad');
    await completeRun(fx.runId);

    const missingNote = await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: fx.datasetId, evalRunId: fx.runId },
      }),
    );
    expect(missingNote.status).toBe(400);

    const badUuid = await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: 'not-a-uuid', evalRunId: fx.runId, note: 'x' },
      }),
    );
    expect(badUuid.status).toBe(400);
  });

  it('非终态 run（PENDING）提名 → 409（裁定 3：fail-closed）', async () => {
    const fx = await insertPendingRun('nominate-pending');
    const res = await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: fx.datasetId, evalRunId: fx.runId, note: 'x' },
      }),
    );
    expect(res.status).toBe(409);
  });

  it('同一 run 重复提名 → 409（裁定 3）', async () => {
    const fx = await insertPendingRun('nominate-dup');
    await completeRun(fx.runId);
    const body = { datasetId: fx.datasetId, evalRunId: fx.runId, note: 'x' };
    const first = await baselinesRoute.POST(req('/api/baselines', { method: 'POST', body }));
    expect(first.status).toBe(201);
    const second = await baselinesRoute.POST(req('/api/baselines', { method: 'POST', body }));
    expect(second.status).toBe(409);
  });

  it('evalRunId 与 datasetId 不属于同一评测集 → 400（脏输入，fail-closed）', async () => {
    const a = await insertPendingRun('nominate-mix-a');
    const b = await insertPendingRun('nominate-mix-b');
    await completeRun(a.runId);
    const res = await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: b.datasetId, evalRunId: a.runId, note: 'x' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('已有 CONFIRMED 基线时提名仍允许 → 201（唯一性由确认时的部分唯一索引兜底，裁定 3）', async () => {
    const fx = await insertPendingRun('nominate-after-confirmed');
    await completeRun(fx.runId);
    const secondRunId = await insertSecondCompletedRun(fx, 'nominate-after-confirmed-2');

    await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: fx.datasetId, evalRunId: fx.runId, note: 'first' },
      }),
    );
    await confirmBySql(fx.runId);

    const res = await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: fx.datasetId, evalRunId: secondRunId, note: 'second' },
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// 基线解析（GET /api/baselines/resolution，PG-08 消费）
// ---------------------------------------------------------------------------

describe('GET /api/baselines/resolution · 基线解析', () => {
  it('无基线：confirmed=null 是一等状态 + pendingNominations=0（契约注释原文语义）', async () => {
    const fx = await insertPendingRun('resolve-empty');
    const res = await resolutionRoute.GET(req(`/api/baselines/resolution?datasetId=${fx.datasetId}`));
    expect(res.status).toBe(200);
    const body = BaselineResolution.parse(await res.json());
    expect(body.datasetId).toBe(fx.datasetId);
    expect(body.confirmed).toBeNull();
    expect(body.pendingNominations).toBe(0);
  });

  it('有确认基线与待审提名：confirmed 指向 CONFIRMED 行，pendingNominations=1', async () => {
    const fx = await insertPendingRun('resolve-mixed');
    await completeRun(fx.runId);
    const secondRunId = await insertSecondCompletedRun(fx, 'resolve-mixed-2');

    await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: fx.datasetId, evalRunId: fx.runId, note: 'first' },
      }),
    );
    await baselinesRoute.POST(
      req('/api/baselines', {
        method: 'POST',
        body: { datasetId: fx.datasetId, evalRunId: secondRunId, note: 'second' },
      }),
    );
    await confirmBySql(fx.runId);

    const res = await resolutionRoute.GET(req(`/api/baselines/resolution?datasetId=${fx.datasetId}`));
    expect(res.status).toBe(200);
    const body = BaselineResolution.parse(await res.json());
    expect(body.confirmed?.evalRunId).toBe(fx.runId);
    expect(body.confirmed?.status).toBe('CONFIRMED');
    expect(body.pendingNominations).toBe(1);
  });

  it('datasetId 缺失 / 非法 → 400；评测集不存在 → 404', async () => {
    expect((await resolutionRoute.GET(req('/api/baselines/resolution'))).status).toBe(400);
    expect(
      (await resolutionRoute.GET(req('/api/baselines/resolution?datasetId=not-a-uuid'))).status,
    ).toBe(400);
    expect(
      (
        await resolutionRoute.GET(
          req('/api/baselines/resolution?datasetId=00000000-0000-4000-8000-000000000000'),
        )
      ).status,
    ).toBe(404);
  });
});
