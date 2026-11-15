/**
 * M3 · Batch 1 —— Baseline 确认 / 驳回（`US-020`，仅 ROLE-B）。
 *
 * **本文件当前整档 RED（TDD）**：`app/api/baselines/[baselineId]/decision/route.ts`
 * 尚未落地 —— 其 403 分支依赖的错误码在 `ErrorCode` 枚举中缺位（无 FORBIDDEN 一类），
 * 契约只读，**已按纪律停下报**，待需求方裁定（建议：按 §1.7 五步走
 * `contracts(M3):` 单独扩枚举）。GREEN 后本文件必须全绿。
 *
 * 依据：`contracts/openapi.yaml` `/api/baselines/{baselineId}/decision`
 * （200 / 403 非 ROLE-B / 409 双基线）、`db/migrations/0016` 的 `trg_baselines_guard`
 * （已裁定行不可 re-decide，流转目标仅 CONFIRMED/REJECTED）、
 * 需求方 2026-11-15 裁定 1（`X-Role: A|B`，缺省 `A`）与裁定 2（`decided_by='local'`）。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Baseline } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { insertPendingRun, restoreSeed, type PendingRunFixture } from './support/fixtures.js';
import { nominateBaseline } from '../lib/api/services/baselines.js';

// Route Handler（RED：本模块尚不存在）
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

/** 在夹具的同一评测集上再插一条 COMPLETED run（双基线场景用）。 */
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

async function completeRun(runId: string): Promise<void> {
  const cur = await getPool().query<{ status: string }>(
    'SELECT status FROM eval_runs WHERE id = $1',
    [runId],
  );
  if (cur.rows[0]?.status === 'COMPLETED') return; // 已终态（insertSecondCompletedRun 直插）则不动——guard 冻结终态行
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

/** 提名一条基线（直接调 service，省一次路由转发；被测物是 decision）。 */
async function nominate(fx: PendingRunFixture, note: string) {
  await completeRun(fx.runId);
  return nominateBaseline({ datasetId: fx.datasetId, evalRunId: fx.runId, note });
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
// US-020 · 确认 / 驳回（POST /api/baselines/{baselineId}/decision）
// ---------------------------------------------------------------------------

describe('POST /api/baselines/{id}/decision · 确认 / 驳回（US-020，仅 ROLE-B）', () => {
  it('缺省（无 X-Role，即 ROLE-A）访问 decision → 403（裁定 1）', async () => {
    const fx = await insertPendingRun('decision-default-role');
    const b = await nominate(fx, 'x');
    const res = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, { method: 'POST', body: { approve: true } }),
      params({ baselineId: b.id }),
    );
    expect(res.status).toBe(403);
  });

  it('X-Role: A → 403（显式带 A 也拦）', async () => {
    const fx = await insertPendingRun('decision-role-a');
    const b = await nominate(fx, 'x');
    const res = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'A' },
        body: { approve: true },
      }),
      params({ baselineId: b.id }),
    );
    expect(res.status).toBe(403);
  });

  it('ROLE-B 确认 → 200，status=CONFIRMED，decidedBy/decidedAt 落定（裁定 2：local）', async () => {
    const fx = await insertPendingRun('decision-confirm');
    const b = await nominate(fx, '稳');
    const res = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: true },
      }),
      params({ baselineId: b.id }),
    );
    expect(res.status).toBe(200);
    const body = Baseline.parse(await res.json());
    expect(body.status).toBe('CONFIRMED');
    expect(body.decidedBy).toBe('local');
    expect(body.decidedAt).not.toBeNull();
  });

  it('同集第二个 CONFIRMED → 409（ux_baselines_one_confirmed 双基线拦截，BL-1）', async () => {
    const fx = await insertPendingRun('decision-double');
    const first = await nominate(fx, 'first');
    const secondRunId = await insertSecondCompletedRun(fx, 'decision-double-2');
    const second = await nominate({ ...fx, runId: secondRunId }, 'second');

    const okRes = await decisionRoute.POST(
      req(`/api/baselines/${first.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: true },
      }),
      params({ baselineId: first.id }),
    );
    expect(okRes.status).toBe(200);

    const conflict = await decisionRoute.POST(
      req(`/api/baselines/${second.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: true },
      }),
      params({ baselineId: second.id }),
    );
    expect(conflict.status).toBe(409);
  });

  it('ROLE-B 驳回 → 200，status=REJECTED', async () => {
    const fx = await insertPendingRun('decision-reject');
    const b = await nominate(fx, '不稳');
    const res = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: false, note: '样本太少' },
      }),
      params({ baselineId: b.id }),
    );
    expect(res.status).toBe(200);
    const body = Baseline.parse(await res.json());
    expect(body.status).toBe('REJECTED');
    expect(body.decidedBy).toBe('local');
  });

  it('已裁定（REJECTED）后再 decision → 409（baselines_guard：不可 re-decide）', async () => {
    const fx = await insertPendingRun('decision-redecide');
    const b = await nominate(fx, 'x');
    const first = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: false, note: '驳回' },
      }),
      params({ baselineId: b.id }),
    );
    expect(first.status).toBe(200);

    const again = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: true },
      }),
      params({ baselineId: b.id }),
    );
    expect(again.status).toBe(409);
  });

  it('驳回不带 note → 保留提名理由（裁定 2：无则保留）', async () => {
    const fx = await insertPendingRun('decision-note-keep');
    const b = await nominate(fx, '召回率表现最好');
    const res = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: false },
      }),
      params({ baselineId: b.id }),
    );
    expect(res.status).toBe(200);
    const row = await getPool().query<{ note: string | null }>(
      'SELECT note FROM baselines WHERE id = $1',
      [b.id],
    );
    expect(row.rows[0]?.note).toBe('召回率表现最好');
  });

  it('驳回带 note → 覆盖提名理由（裁定 2：有则覆盖）', async () => {
    const fx = await insertPendingRun('decision-note-overwrite');
    const b = await nominate(fx, '召回率表现最好');
    const res = await decisionRoute.POST(
      req(`/api/baselines/${b.id}/decision`, {
        method: 'POST',
        headers: { 'x-role': 'B' },
        body: { approve: false, note: '样本太少，不具备代表性' },
      }),
      params({ baselineId: b.id }),
    );
    expect(res.status).toBe(200);
    const row = await getPool().query<{ note: string | null }>(
      'SELECT note FROM baselines WHERE id = $1',
      [b.id],
    );
    expect(row.rows[0]?.note).toBe('样本太少，不具备代表性');
  });
});
