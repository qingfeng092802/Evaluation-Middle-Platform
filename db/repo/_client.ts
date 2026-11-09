/**
 * 仓储层底座：**唯一**允许出现 SQL 的地方（SPEC-M1 §1.4 分层）。
 *
 * `app/` 与 `worker/` 只能调 `db/repo/*`，不得自己拼 SQL —— 否则
 * 「触发器 / 生成列 / 部分索引」这些只在数据库里成立的口径会被各调用点重新发明一遍。
 *
 * 数值口径：`pg` 把 `numeric` 读成 **string**（防精度丢失）。仓储层负责把它
 * 转成 `number` 再交给契约层校验，转换点集中在这里，不散落在路由里。
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../schema/index.js';

/** 执行一条 SQL，返回行数组。 */
export async function query<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(sql, params as unknown[]);
  return res.rows;
}

/** 执行一条 SQL，返回第一行（无行则 `null`）。 */
export async function queryOne<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** 在单个事务里执行；抛错则回滚并原样抛出（调用方据此决定 HTTP 码）。 */
export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * `numeric` → `number`。
 *
 * 只在**读取视图**上使用；写入时一律把数字作为字符串交回 SQL，
 * 让数据库以 numeric 精度处理（`OPEN-3`：禁止 Node 浮点累加）。
 */
export function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/** `numeric | null` → `number | null`。 */
export function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}

/** timestamptz → ISO 串（契约 `IsoDateTime` 要求带 offset）。 */
export function iso(v: Date | string): string {
  return typeof v === 'string' ? new Date(v).toISOString() : v.toISOString();
}

/** timestamptz | null → ISO 串 | null。 */
export function isoOrNull(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return iso(v);
}

/** 唯一约束冲突（Postgres 23505）。调用方据此返回 409 而不是 500。 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** CHECK 约束失败（Postgres 23514）。 */
export function isCheckViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23514';
}

/** 触发器主动 RAISE（如不可变表、非法状态流转）——用 P0001 承载业务错误。 */
export function isRaiseException(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P0001';
}
