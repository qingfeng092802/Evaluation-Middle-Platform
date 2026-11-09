/**
 * 队列仓储的真库回归（`[BE-03]` · `claim_next_run` 的空队列语义）。
 *
 * **这条测试来自一次真实故障**：首次跑 `npm run dev:all` 时，worker 在空队列上
 * 以 200ms 的节奏刷出
 *
 *     [worker] run null 不存在，跳过
 *
 * 原因是 `claim_next_run()` 返回的是**复合类型**（`RETURNS eval_runs`）。
 * PL/pgSQL 里 `RETURN NULL` 表达的「没有行」，经过 `SELECT ... FROM f()` 之后
 * **仍然是一行**，只是每个字段都是 NULL —— 于是 `queryOne()` 拿到
 * `{ id: null, ... }`，`if (!row) return null` 判不出来。
 *
 * 修法在 SQL 侧：`RETURNS SETOF eval_runs` + `RETURN` 空集合时才是零行。
 * 这里把它钉死：空队列必须返回 `null`，不能返回一个字段全空的「幽灵行」。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { claimNextRun } from '../db/repo/queue.js';
import { closeDb, getPool } from '../db/schema/index.js';

const DB_URL = process.env['DATABASE_URL'];

async function sql(text: string, params: unknown[] = []): Promise<void> {
  await getPool().query(text, params);
}

async function oneId(text: string, params: unknown[] = []): Promise<string> {
  const res = await getPool().query<{ id: string }>(text, params);
  const row = res.rows[0];
  if (!row) throw new Error(`期望返回一行：${text}`);
  return row.id;
}

/** 最小可领取的图：数据集版本 → 目标版本 → 一条 PENDING run。 */
async function insertPendingRun(name: string): Promise<string> {
  const ds = await oneId(`INSERT INTO datasets (name, owner_id) VALUES ($1, 't') RETURNING id`, [name]);
  const dv = await oneId(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1, 1, 1, 'sha256:abc', 'import', 't') RETURNING id`,
    [ds],
  );
  const mp = await oneId(
    `INSERT INTO model_providers (name, kind, api_key_ciphertext, api_key_masked)
     VALUES ($1, 'openai_compatible', 'fixture-noop', 'fixture-••••noop') RETURNING id`,
    [`mp-${name}`],
  );
  const tg = await oneId(
    `INSERT INTO targets (name, kind, owner_id) VALUES ($1, 't1_prompt', 't') RETURNING id`,
    [`tg-${name}`],
  );
  const tv = await oneId(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1, 1, 't1_prompt', $2, 'fixture-echo-1', '{{input}}', 0, 64, 't') RETURNING id`,
    [tg, mp],
  );
  return oneId(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1, $2, $3, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', 1, 'PENDING') RETURNING id`,
    [`run-${name}`, dv, tv],
  );
}

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
  await resetDatabase(DB_URL);
});

afterAll(async () => {
  await closeDb();
  // 供将来接入其它真库 spec 时确认连接确实关掉了
  await connect(DB_URL)
    .then((c) => c.end())
    .catch(() => undefined);
});

describe('claim_next_run · 空队列必须返回 null', () => {
  it('队列为空时不是「幽灵行」，而是 null', async () => {
    const claimed = await claimNextRun();
    expect(claimed).toBeNull();
  });

  it('SQL 层本身也必须零行（不是一行全 NULL）', async () => {
    const res = await getPool().query(`SELECT * FROM claim_next_run()`);
    expect(res.rows).toHaveLength(0);
  });

  it('有一条 PENDING 时领取成功，并把状态推到 RUNNING', async () => {
    const runId = await insertPendingRun('a');
    const claimed = await claimNextRun();
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(runId);
    expect(claimed?.totalCases).toBe(1);

    const after = await getPool().query<{ status: string; started_at: Date | null }>(
      `SELECT status, started_at FROM eval_runs WHERE id = $1`,
      [runId],
    );
    expect(after.rows[0]?.status).toBe('RUNNING');
    expect(after.rows[0]?.started_at).not.toBeNull();
  });

  it('领取之后队列再次变空 ⇒ 再次返回 null（不会重复领同一条）', async () => {
    await insertPendingRun('b');
    expect(await claimNextRun()).not.toBeNull();
    expect(await claimNextRun()).toBeNull();
  });

  it('两条 PENDING 按 created_at 先进先出', async () => {
    await insertPendingRun('first');
    // 同毫秒插入时 created_at 可能相同；显式错开保证顺序可断言
    await sql(
      `UPDATE eval_runs SET created_at = now() - interval '1 minute' WHERE name = 'run-first'`,
    );
    const second = await insertPendingRun('second');

    const firstClaimed = await claimNextRun();
    expect(firstClaimed?.id).not.toBeNull();
    expect(firstClaimed?.id).not.toBe(second);
    expect((await claimNextRun())?.id).toBe(second);
    expect(await claimNextRun()).toBeNull();
  });
});
