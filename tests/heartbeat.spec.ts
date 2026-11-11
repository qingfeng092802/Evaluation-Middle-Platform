/**
 * 心跳租约（方案 A）· 数据层回归。
 *
 * #6 缺陷：`reclaim_stale_runs()` 只看 `started_at`，任何耗时超过阈值的**正常** run
 * 都会被另一个 worker 当成僵尸回收并二次执行。行级幂等（`ON CONFLICT DO NOTHING`）
 * 挡得住重复行，挡不住重复的**网关调用** —— 真网关下就是重复计费。
 *
 * 方案 A：worker 在处理期间按 `leaseDuration/3` 续写 `eval_runs.heartbeat_at`；
 * 回收判定改为 `GREATEST(started_at, heartbeat_at) < now() - p_stale_after`。
 * `heartbeat_at IS NULL`（旧行 / 刚领取尚未心跳）回退到 `started_at`，
 * 从而 T-13/T-14 的既有语义原样保留。
 *
 * 本文件只钉「数据层」；真 worker 进程级的验证见 `tests/heartbeat-worker.spec.ts`。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';

let client: Client;

async function one<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const res = await client.query<T>(sql, params);
  const row = res.rows[0];
  if (!row) throw new Error(`期望返回一行但为空：${sql}`);
  return row;
}

async function seedMinimalGraph(): Promise<{ datasetVersionId: string; targetVersionId: string }> {
  const ds = await one<{ id: string }>(
    `INSERT INTO datasets (name, owner_id) VALUES ($1, 't') RETURNING id`,
    [`ds-${Math.random().toString(36).slice(2)}`],
  );
  const dv = await one<{ id: string }>(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1, 1, 1, 'sha256:abc', 'import', 't') RETURNING id`,
    [ds.id],
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
  return { datasetVersionId: dv.id, targetVersionId: tv.id };
}

async function insertRun(status: 'PENDING' | 'RUNNING'): Promise<string> {
  const g = await seedMinimalGraph();
  const row = await one<{ id: string }>(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1, $2, $3, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', 1, $4) RETURNING id`,
    [`run-${Math.random().toString(36).slice(2)}`, g.datasetVersionId, g.targetVersionId, status],
  );
  return row.id;
}

beforeAll(async () => {
  client = new Client({ connectionString: databaseUrl() });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  await resetDatabase(databaseUrl());
});

describe('H-01 迁移：eval_runs.heartbeat_at', () => {
  it('存在 heartbeat_at 列，类型 timestamptz 且可空', async () => {
    const row = await one<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'eval_runs' AND column_name = 'heartbeat_at'`,
    );
    expect(row.data_type).toBe('timestamp with time zone');
    expect(row.is_nullable).toBe('YES');
  });
});

describe('H-02 回收判定：GREATEST(started_at, heartbeat_at)', () => {
  it('心跳持续更新时，即使 started_at 很旧也不回收', async () => {
    const id = await insertRun('RUNNING');
    await client.query(
      `UPDATE eval_runs
          SET started_at = now() - interval '1 hour',
              heartbeat_at = now()
        WHERE id = $1`,
      [id],
    );

    const r = await one<{ n: number }>(`SELECT reclaim_stale_runs('10 minutes') AS n`);

    expect(Number(r.n)).toBe(0);
    const row = await one<{ status: string }>(`SELECT status FROM eval_runs WHERE id = $1`, [id]);
    expect(row.status).toBe('RUNNING');
  });

  it('心跳停止（最后一次心跳也超过阈值）后回收', async () => {
    // 典型崩溃场景：run 已跑很久（started_at 远超阈值），心跳维持过一段，
    // 然后 worker 崩溃、心跳停止、超过 TTL ⇒ 可被另一 worker 回收。
    const id = await insertRun('RUNNING');
    await client.query(
      `UPDATE eval_runs
          SET started_at = now() - interval '1 hour',
              heartbeat_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [id],
    );

    const r = await one<{ n: number }>(`SELECT reclaim_stale_runs('10 minutes') AS n`);

    expect(Number(r.n)).toBe(1);
    const row = await one<{ status: string; heartbeat_at: string | null }>(
      `SELECT status, heartbeat_at::text AS heartbeat_at FROM eval_runs WHERE id = $1`,
      [id],
    );
    expect(row.status).toBe('PENDING');
    // 回收后清空心跳：下一次领取是干净状态
    expect(row.heartbeat_at).toBeNull();
  });

  it('heartbeat_at 为 NULL 的旧行按 started_at 判定（不误回收、也不漏回收）', async () => {
    const stale = await insertRun('RUNNING');
    await client.query(
      `UPDATE eval_runs SET started_at = now() - interval '1 hour' WHERE id = $1`,
      [stale],
    );
    const fresh = await insertRun('RUNNING');
    await client.query(`UPDATE eval_runs SET started_at = now() WHERE id = $1`, [fresh]);

    const r = await one<{ n: number }>(`SELECT reclaim_stale_runs('10 minutes') AS n`);

    expect(Number(r.n)).toBe(1);
    const rows = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM eval_runs WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[stale, fresh]],
    );
    const byId = new Map(rows.rows.map((x) => [x.id, x.status]));
    expect(byId.get(stale)).toBe('PENDING');
    expect(byId.get(fresh)).toBe('RUNNING');
  });
});

describe('H-03 down 脚本：影子库前滚 → 回滚 → 再前滚', () => {
  function shadowAdminUrl(): string {
    const u = new URL(databaseUrl());
    u.pathname = '/postgres';
    return u.toString();
  }

  function shadowUrl(name: string): string {
    const u = new URL(databaseUrl());
    u.pathname = `/${name}`;
    return u.toString();
  }

  it('down 脚本可执行，回滚后 heartbeat_at 消失且回收退回按 started_at 判定', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { MIGRATIONS_DIR, listMigrationFiles } = await import('../db/migrate.js');

    const downFile = join(MIGRATIONS_DIR, 'down', '0018_heartbeat_lease.down.sql');
    const upFile = join(MIGRATIONS_DIR, '0018_heartbeat_lease.sql');

    // down 脚本不能是会被 migrate() 自动执行的文件
    expect(await listMigrationFiles()).not.toContain('0018_heartbeat_lease.down.sql');

    const dbName = `eval_shadow_hb_${Date.now()}`;
    const admin = new Client({ connectionString: shadowAdminUrl() });
    await admin.connect();
    let shadow: Client | null = null;
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      shadow = new Client({ connectionString: shadowUrl(dbName) });
      await shadow.connect();

      await migrate(shadowUrl(dbName));
      const before = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_name = 'eval_runs' AND column_name = 'heartbeat_at'`,
      );
      expect(before.rows[0]?.n).toBe('1');

      await shadow.query(await readFile(downFile, 'utf8'));

      const after = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_name = 'eval_runs' AND column_name = 'heartbeat_at'`,
      );
      expect(after.rows[0]?.n).toBe('0');
      const applied = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM schema_migrations WHERE file = '0018_heartbeat_lease.sql'`,
      );
      expect(applied.rows[0]?.n).toBe('0');

      // 回滚后的回收函数必须回到 0017 语义：只看 started_at
      // （在影子库里没有业务数据，用 pg_get_functiondef 直接比对判定条件）
      const fn = await shadow.query<{ def: string }>(
        `SELECT pg_get_functiondef('reclaim_stale_runs(interval)'::regprocedure) AS def`,
      );
      expect(fn.rows[0]?.def).not.toContain('heartbeat_at');

      // 再前滚：同一份 up 脚本可以重复执行
      await shadow.query(await readFile(upFile, 'utf8'));
      const again = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_name = 'eval_runs' AND column_name = 'heartbeat_at'`,
      );
      expect(again.rows[0]?.n).toBe('1');
    } finally {
      if (shadow) await shadow.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  }, 60_000);
});
