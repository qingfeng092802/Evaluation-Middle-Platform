/**
 * 数据库连接与迁移基础设施。
 *
 * 设计要点：
 *  - **只用 `pg`**，不引 ORM 的迁移器：DDL 是手写 SQL（`technical-solution.md` TS-4 短板 3
 *    已点名 Drizzle 表达不了触发器），ORM 只做查询。
 *  - 迁移执行记录在 `schema_migrations` 表里，**可重复执行**（幂等）。
 *  - 每个迁移文件在**独立事务**中执行：一个失败不会留下半套结构。
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

/** `src/db/migrations` 的绝对路径（本文件位于 `src/db/`）。 */
export const MIGRATIONS_DIR = join(here, 'migrations');

/** 默认连接串：与 docker-compose.yml 一致（仅本机开发用）。 */
export const DEFAULT_DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://eval:eval_local_dev_only@127.0.0.1:5433/eval_platform';

export function databaseUrl(): string {
  return process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
}

/** 新建一个已连接的 Client。调用方负责 `end()`。 */
export async function connect(url: string = databaseUrl()): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** 按文件名排序读取全部迁移（0001…0017 的字典序即执行顺序）。 */
export async function listMigrationFiles(): Promise<string[]> {
  const names = await readdir(MIGRATIONS_DIR);
  return names.filter((n) => n.endsWith('.sql')).sort();
}

async function ensureMigrationTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      file       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 执行所有尚未应用的迁移。
 *
 * @returns 本次实际应用的文件名（已应用过的跳过）。
 */
export async function migrate(url: string = databaseUrl()): Promise<string[]> {
  const client = await connect(url);
  const applied: string[] = [];
  try {
    await ensureMigrationTable(client);
    const done = new Set(
      (await client.query<{ file: string }>('SELECT file FROM schema_migrations')).rows.map(
        (r) => r.file,
      ),
    );
    for (const file of await listMigrationFiles()) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (file) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`迁移 ${file} 失败：${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/**
 * 清空全部业务表（测试用）。
 *
 * 只删数据不删结构：`schema_migrations` 保留，迁移不会被重复执行。
 * 顺序为外键反向序；`eval_runs` 有 `trg_eval_runs_no_delete` 触发器，
 * 因此必须 `SET session_replication_role = replica` 才能清空 —— 这是测试专用的
 * 后门，仅在 `resetDatabase()` 内使用，业务代码永不调用。
 */
export async function resetDatabase(url: string = databaseUrl()): Promise<void> {
  const client = await connect(url);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(`
      TRUNCATE TABLE
        case_human_labels,
        gate_evaluations,
        run_evaluators,
        eval_case_results,
        eval_runs,
        baselines,
        regression_gates,
        evaluators,
        target_versions,
        targets,
        model_prices,
        model_providers,
        dataset_cases,
        dataset_versions,
        datasets
      RESTART IDENTITY CASCADE
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

/** 丢弃整个 schema 并重建（真·空库，供迁移测试用）。 */
export async function dropAndRecreateSchema(url: string = databaseUrl()): Promise<void> {
  const client = await connect(url);
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}
