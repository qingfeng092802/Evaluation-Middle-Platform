/**
 * 迁移测试：`T-01`…`T-22` 全 22 条（`database-schema.md` §6 的验收门槛）。
 *
 * 这些测试跑在**真实 PostgreSQL**上（不 mock 数据库）：
 * 不可变性由触发器保证，而触发器无法在内存里验证。
 *
 * 每个用例前先 `dropAndRecreateSchema()` 得到真·空库，再跑全部迁移 ——
 * 这样「空库 → 迁移一次成功」本身也被验证（AC-1 的前提）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import {
  DB_FUNCTION_NAMES,
  EXPECTED_TRIGGER_COUNT,
  TRIGGER_NAMES,
} from '@eval-platform/contracts';

let client: Client;

/** 断言某条 SQL 因数据库错误而失败，并返回错误消息。 */
async function expectDbError(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await client.query(sql, params);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`期望 SQL 失败但成功了：${sql}`);
}

async function one<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const res = await client.query<T>(sql, params);
  const row = res.rows[0];
  if (!row) throw new Error(`期望返回一行但为空：${sql}`);
  return row;
}

// ---------------------------------------------------------------------------
// 造数据用的小工具：每次取一条最小可用的数据集 / 版本 / 目标版本 / 运行
// ---------------------------------------------------------------------------

async function seedMinimalGraph(): Promise<{
  datasetVersionId: string;
  targetVersionId: string;
  datasetCaseId: string;
}> {
  const ds = await one<{ id: string }>(
    `INSERT INTO datasets (name, owner_id) VALUES ($1, 't') RETURNING id`,
    [`ds-${Math.random().toString(36).slice(2)}`],
  );
  const dv = await one<{ id: string }>(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1, 1, 1, 'sha256:abc', 'import', 't') RETURNING id`,
    [ds.id],
  );
  const dc = await one<{ id: string }>(
    `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input)
     VALUES ($1, 'case-1', 0, '{"query":"hi"}'::jsonb) RETURNING id`,
    [dv.id],
  );
  const mp = await one<{ id: string }>(
    `INSERT INTO model_providers (name, kind, api_key_ciphertext, api_key_masked)
     VALUES ($1, 'openai_compatible', 'fixture-noop', 'fixture-••••noop') RETURNING id`,
    [`mp-${Math.random().toString(36).slice(2)}`],
  );
  const tg = await one<{ id: string }>(
    `INSERT INTO targets (name, kind, owner_id) VALUES ($1, 't1_prompt', 't') RETURNING id`,
    [`tg-${Math.random().toString(36).slice(2)}`],
  );
  const tv = await one<{ id: string }>(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1, 1, 't1_prompt', $2, 'fixture-echo-1', '{{input}}', 0, 64, 't') RETURNING id`,
    [tg.id, mp.id],
  );
  return { datasetVersionId: dv.id, targetVersionId: tv.id, datasetCaseId: dc.id };
}

async function insertRun(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const g = await seedMinimalGraph();
  const row = await one<{ id: string }>(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1, $2, $3, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', 1, $4) RETURNING id`,
    [
      overrides['name'] ?? `run-${Math.random().toString(36).slice(2)}`,
      g.datasetVersionId,
      g.targetVersionId,
      overrides['status'] ?? 'PENDING',
    ],
  );
  return row.id;
}

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await dropAndRecreateSchema(process.env['DATABASE_URL']);
  await migrate(process.env['DATABASE_URL']);
  await resetDatabase(process.env['DATABASE_URL']);
});

describe('AC-1 · 迁移与不可变红线', () => {
  it('T-10 触发器全名单恰好 17 个，且逐一存在', async () => {
    const res = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    );
    const actual = res.rows.map((r) => r.tgname).sort();
    expect(EXPECTED_TRIGGER_COUNT).toBe(17);
    expect(actual).toEqual([...TRIGGER_NAMES].sort());
  });

  it('T-18 claim_next_run 与 reclaim_stale_runs 均存在', async () => {
    const res = await client.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname = ANY($1::text[])`,
      [[...DB_FUNCTION_NAMES]],
    );
    const found = res.rows.map((r) => r.proname).sort();
    expect(found).toEqual([...DB_FUNCTION_NAMES].sort());
  });

  it('迁移脚本全文不含 DROP TABLE / TRUNCATE / DELETE FROM', async () => {
    const { listMigrationFiles, MIGRATIONS_DIR } = await import('../db/migrate.js');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    for (const f of await listMigrationFiles()) {
      const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
      // 去掉行注释后再判断，避免把说明文字当成语句
      const code = sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .toUpperCase();
      expect(code, `${f} 含 DROP TABLE`).not.toContain('DROP TABLE');
      expect(code, `${f} 含 TRUNCATE`).not.toContain('TRUNCATE');
      expect(code, `${f} 含 DELETE FROM`).not.toContain('DELETE FROM');
    }
  });

  it('T-01 对 dataset_versions 执行 UPDATE 抛异常', async () => {
    const g = await seedMinimalGraph();
    await expectDbError(`UPDATE dataset_versions SET note = 'x' WHERE id = $1`, [
      g.datasetVersionId,
    ]).then((m) => expect(m).toContain('immutable table'));
  });

  it('T-02 对 dataset_cases 执行 DELETE 抛异常', async () => {
    const g = await seedMinimalGraph();
    await expectDbError(`DELETE FROM dataset_cases WHERE id = $1`, [g.datasetCaseId]).then((m) =>
      expect(m).toContain('immutable table'),
    );
  });

  it('T-03 对 eval_case_results 执行 UPDATE 抛异常', async () => {
    const runId = await insertRun();
    const row = await one<{ id: string }>(
      `INSERT INTO eval_case_results
         (eval_run_id, dataset_case_id, case_key, status, score)
       SELECT $1, dc.id, dc.case_key, 'OK', 1
         FROM eval_runs r JOIN dataset_cases dc ON dc.dataset_version_id = r.dataset_version_id
        WHERE r.id = $1 LIMIT 1
       RETURNING id`,
      [runId],
    );
    await expectDbError(`UPDATE eval_case_results SET score = 0 WHERE id = $1`, [row.id]).then((m) =>
      expect(m).toContain('immutable table'),
    );
  });

  it('T-19 case_human_labels UPDATE 抛异常', async () => {
    const runId = await insertRun();
    const r = await one<{ id: string }>(
      `INSERT INTO eval_case_results (eval_run_id, dataset_case_id, case_key, status, score)
       SELECT $1, dc.id, dc.case_key, 'OK', 1
         FROM eval_runs r JOIN dataset_cases dc ON dc.dataset_version_id = r.dataset_version_id
        WHERE r.id = $1 LIMIT 1 RETURNING id`,
      [runId],
    );
    const l = await one<{ id: string }>(
      `INSERT INTO case_human_labels (eval_case_result_id, label, labeled_by)
       VALUES ($1, 'retrieval_miss', 't') RETURNING id`,
      [r.id],
    );
    await expectDbError(`UPDATE case_human_labels SET note = 'x' WHERE id = $1`, [l.id]).then((m) =>
      expect(m).toContain('immutable table'),
    );
  });

  it('T-20 case_human_labels DELETE 抛异常', async () => {
    const runId = await insertRun();
    const r = await one<{ id: string }>(
      `INSERT INTO eval_case_results (eval_run_id, dataset_case_id, case_key, status, score)
       SELECT $1, dc.id, dc.case_key, 'OK', 1
         FROM eval_runs r JOIN dataset_cases dc ON dc.dataset_version_id = r.dataset_version_id
        WHERE r.id = $1 LIMIT 1 RETURNING id`,
      [runId],
    );
    const l = await one<{ id: string }>(
      `INSERT INTO case_human_labels (eval_case_result_id, label, labeled_by)
       VALUES ($1, 'hallucination', 't') RETURNING id`,
      [r.id],
    );
    await expectDbError(`DELETE FROM case_human_labels WHERE id = $1`, [l.id]).then((m) =>
      expect(m).toContain('immutable table'),
    );
  });

  it('T-21 同一 eval_case_result_id 允许多条标注（刻意不建唯一约束）', async () => {
    const runId = await insertRun();
    const r = await one<{ id: string }>(
      `INSERT INTO eval_case_results (eval_run_id, dataset_case_id, case_key, status, score)
       SELECT $1, dc.id, dc.case_key, 'OK', 1
         FROM eval_runs r JOIN dataset_cases dc ON dc.dataset_version_id = r.dataset_version_id
        WHERE r.id = $1 LIMIT 1 RETURNING id`,
      [runId],
    );
    await client.query(
      `INSERT INTO case_human_labels (eval_case_result_id, label, labeled_by) VALUES ($1,'a','t')`,
      [r.id],
    );
    await client.query(
      `INSERT INTO case_human_labels (eval_case_result_id, label, labeled_by) VALUES ($1,'b','t')`,
      [r.id],
    );
    const c = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM case_human_labels WHERE eval_case_result_id = $1`,
      [r.id],
    );
    expect(c.n).toBe('2');
  });

  it('T-22 severity 只接受 low/medium/high/NULL', async () => {
    const runId = await insertRun();
    const r = await one<{ id: string }>(
      `INSERT INTO eval_case_results (eval_run_id, dataset_case_id, case_key, status, score)
       SELECT $1, dc.id, dc.case_key, 'OK', 1
         FROM eval_runs r JOIN dataset_cases dc ON dc.dataset_version_id = r.dataset_version_id
        WHERE r.id = $1 LIMIT 1 RETURNING id`,
      [runId],
    );
    const msg = await expectDbError(
      `INSERT INTO case_human_labels (eval_case_result_id, label, severity, labeled_by)
       VALUES ($1, 'x', 'critical', 't')`,
      [r.id],
    );
    expect(msg).toContain('ck_case_human_labels_severity');
  });

  it('T-04 eval_runs 终态行 UPDATE 抛异常', async () => {
    const id = await insertRun({ status: 'RUNNING' });
    await client.query(`UPDATE eval_runs SET status = 'COMPLETED' WHERE id = $1`, [id]);
    const msg = await expectDbError(`UPDATE eval_runs SET name = 'x' WHERE id = $1`, [id]);
    expect(msg).toContain('terminal');
  });

  it('T-05 非法流转 PENDING → COMPLETED 抛异常', async () => {
    const id = await insertRun();
    const msg = await expectDbError(`UPDATE eval_runs SET status = 'COMPLETED' WHERE id = $1`, [id]);
    expect(msg).toContain('illegal status transition');
  });

  it('T-06 合法流转 PENDING → RUNNING → COMPLETED 成功', async () => {
    const id = await insertRun();
    await client.query(`UPDATE eval_runs SET status = 'RUNNING' WHERE id = $1`, [id]);
    await client.query(`UPDATE eval_runs SET status = 'COMPLETED' WHERE id = $1`, [id]);
    const row = await one<{ status: string }>(`SELECT status FROM eval_runs WHERE id = $1`, [id]);
    expect(row.status).toBe('COMPLETED');
  });
});

describe('AC-1 · 数据约束', () => {
  it('T-07 第二条 CONFIRMED 基线插入失败', async () => {
    const runId = await insertRun();
    const ds = await one<{ dataset_id: string }>(
      `SELECT dataset_version_id AS dataset_id FROM eval_runs WHERE id = $1`,
      [runId],
    );
    const realDs = await one<{ dataset_id: string }>(
      `SELECT dataset_id FROM dataset_versions WHERE id = $1`,
      [ds.dataset_id],
    );
    await client.query(
      `INSERT INTO baselines (dataset_id, eval_run_id, status, nominated_by, decided_by, decided_at)
       VALUES ($1, $2, 'CONFIRMED', 't', 't', now())`,
      [realDs.dataset_id, runId],
    );
    const msg = await expectDbError(
      `INSERT INTO baselines (dataset_id, eval_run_id, status, nominated_by, decided_by, decided_at)
       VALUES ($1, $2, 'CONFIRMED', 't', 't', now())`,
      [realDs.dataset_id, runId],
    );
    expect(msg).toContain('ux_baselines_one_confirmed');
  });

  it('T-08 baselines 已决行再决抛异常', async () => {
    const runId = await insertRun();
    const v = await one<{ dataset_id: string }>(
      `SELECT dataset_id FROM dataset_versions WHERE id = (SELECT dataset_version_id FROM eval_runs WHERE id = $1)`,
      [runId],
    );
    const b = await one<{ id: string }>(
      `INSERT INTO baselines (dataset_id, eval_run_id, status, nominated_by, decided_by, decided_at)
       VALUES ($1, $2, 'CONFIRMED', 't', 't', now()) RETURNING id`,
      [v.dataset_id, runId],
    );
    const msg = await expectDbError(`UPDATE baselines SET status = 'REJECTED' WHERE id = $1`, [b.id]);
    expect(msg).toContain('already decided');
  });

  it('T-09 dataset_cases 同版本重复 case_key 插入失败', async () => {
    const g = await seedMinimalGraph();
    const msg = await expectDbError(
      `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input)
       VALUES ($1, 'case-1', 1, '{"query":"x"}'::jsonb)`,
      [g.datasetVersionId],
    );
    expect(msg).toContain('ux_dataset_cases_version_key');
  });

  it('T-11 cost_total 生成列随分列自动更新', async () => {
    const id = await insertRun();
    await client.query(
      `UPDATE eval_runs SET cost_target = 0.25, cost_judge = 0.5 WHERE id = $1`,
      [id],
    );
    const row = await one<{ total: string; target: string; judge: string }>(
      `SELECT cost_total::text AS total, cost_target::text AS target, cost_judge::text AS judge
         FROM eval_runs WHERE id = $1`,
      [id],
    );
    expect(Number(row.total)).toBeCloseTo(Number(row.target) + Number(row.judge), 8);
    expect(Number(row.total)).toBeCloseTo(0.75, 8);
  });

  it('T-12 ck_eval_runs_failed_null_score 生效', async () => {
    const id = await insertRun({ status: 'RUNNING' });
    const msg = await expectDbError(
      `UPDATE eval_runs SET status = 'FAILED', score_overall = 0.5 WHERE id = $1`,
      [id],
    );
    expect(msg).toContain('ck_eval_runs_failed_null_score');
  });

  it('T-13 reclaim_stale_runs 把超时 RUNNING 退回 PENDING', async () => {
    const id = await insertRun({ status: 'RUNNING' });
    await client.query(`UPDATE eval_runs SET started_at = now() - interval '1 hour' WHERE id = $1`, [
      id,
    ]);
    const r = await one<{ n: number }>(`SELECT reclaim_stale_runs('10 minutes') AS n`);
    expect(Number(r.n)).toBeGreaterThanOrEqual(1);
    const row = await one<{ status: string; started_at: string | null }>(
      `SELECT status, started_at::text AS started_at FROM eval_runs WHERE id = $1`,
      [id],
    );
    expect(row.status).toBe('PENDING');
    expect(row.started_at).toBeNull();
  });

  it('T-14 回收不吃正常长任务', async () => {
    const id = await insertRun({ status: 'RUNNING' });
    await client.query(`UPDATE eval_runs SET started_at = now() WHERE id = $1`, [id]);
    const r = await one<{ n: number }>(`SELECT reclaim_stale_runs('10 minutes') AS n`);
    expect(Number(r.n)).toBe(0);
    const row = await one<{ status: string }>(`SELECT status FROM eval_runs WHERE id = $1`, [id]);
    expect(row.status).toBe('RUNNING');
  });

  it('T-15 trigger_source 只接受两个值', async () => {
    const g = await seedMinimalGraph();
    const msg = await expectDbError(
      `INSERT INTO eval_runs
         (name, dataset_version_id, target_version_id, concurrency, config_snapshot,
          reproducibility, runner_version, created_by, trigger_source)
       VALUES ('x', $1, $2, 4, '{}'::jsonb, '{}'::jsonb, 't', 't', 'CRON')`,
      [g.datasetVersionId, g.targetVersionId],
    );
    expect(msg).toContain('ck_eval_runs_source');
  });

  it('T-16 baseline_run_id 指向自身被拒', async () => {
    const id = await insertRun();
    const msg = await expectDbError(`UPDATE eval_runs SET baseline_run_id = id WHERE id = $1`, [id]);
    expect(msg).toContain('ck_eval_runs_no_self_baseline');
  });

  it('T-17 metadata 非对象被拒', async () => {
    const g = await seedMinimalGraph();
    const msg = await expectDbError(
      `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input, metadata)
       VALUES ($1, 'case-2', 1, '{"query":"x"}'::jsonb, '[1,2]'::jsonb)`,
      [g.datasetVersionId],
    );
    expect(msg).toContain('ck_dataset_cases_meta_obj');
  });
});
