/**
 * `B-07`/`B-08` 回归：**声明计数必须等于实际行数**。
 *
 * ## 现场
 *
 * `tests/queue.spec.ts` 的夹具用手写 SQL 直接插行，绕过了 `db/repo/*`：
 *
 *  - `dataset_versions.case_count` 写死 1，却**一条 `dataset_cases` 都没插**；
 *  - `targets.current_version_no` 用默认值 0，却插了 `target_versions` v1；
 *  - `model_providers.base_url` 没写，留成 NULL。
 *
 * 跑完这条 spec，库里就多出「显示 1 条样本、点进去 0 行」的数据集，
 * 和「指向 v0、却挂着 v1」的 Target。收尾也只关了连接池，没有复原种子 ——
 * 残留会一路留到下一次人工点页面才被发现（就是 `B-07`/`B-08` 的由来）。
 *
 * ## 两条防线
 *
 *  1. **夹具自己守规矩**：`tests/support/fixtures.ts` 写出的图必须自洽；
 *  2. **收尾复原种子**：`restoreSeed()`（`tests/support/fixtures.ts`） 把库还原成「只有种子」的状态，
 *     下一个 spec 启动时看到的一定是可预期的库，而不是上一轮的残渣。
 *
 * 断言针对的是**数据库里的行**，不是仓储函数的返回值 —— `createVersion()` 的
 * 返回值就算对了，只要没真写进 `dataset_cases`，这里一样红。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { insertPendingRun, restoreSeed } from './support/fixtures.js';
import { allIntegrityViolations, describeViolations } from './support/db-integrity.js';

const DB_URL = process.env['DATABASE_URL'];

/** 种子的预期行数（与 `scripts/seed.ts` 的写入范围一致：不种 Target、不种 Run）。 */
const SEEDED = {
  providers: 1,
  prices: 1,
  datasets: 1,
  versions: 1,
  cases: 20,
  targets: 0,
  runs: 0,
} as const;

async function count(table: string): Promise<number> {
  const res = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? 0);
}

async function snapshot(): Promise<Record<keyof typeof SEEDED, number>> {
  return {
    providers: await count('model_providers'),
    prices: await count('model_prices'),
    datasets: await count('datasets'),
    versions: await count('dataset_versions'),
    cases: await count('dataset_cases'),
    targets: await count('targets'),
    runs: await count('eval_runs'),
  };
}

/** 全库复位 + 重放种子。任何真库 spec 的收尾都可以直接调用。 */
async function restore(): Promise<void> {
  await closeDb();
  await restoreSeed(DB_URL);
  await closeDb();
}

beforeAll(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
  await resetDatabase(DB_URL);
});

afterAll(async () => {
  await restore();
});

describe('`B-07`/`B-08` · 夹具写出的图必须自洽', () => {
  it('插入一条 PENDING run 后，声明计数与实际行数全部一致', async () => {
    const fixture = await insertPendingRun('integrity-a');

    const violations = await allIntegrityViolations();
    expect(
      violations,
      `夹具留下了声明值与实际行数不一致的数据：\n${describeViolations(violations)}`,
    ).toHaveLength(0);

    // 单独再钉一次最直接的那条：声明 1 条样本 ⇒ 库里真有 1 行
    const res = await getPool().query<{ case_count: number; actual: string }>(
      `SELECT dv.case_count,
              (SELECT count(*)::text FROM dataset_cases c
                WHERE c.dataset_version_id = dv.id) AS actual
         FROM dataset_versions dv WHERE dv.id = $1`,
      [fixture.datasetVersionId],
    );
    const row = res.rows[0];
    expect(row).toBeDefined();
    expect(Number(row?.case_count)).toBeGreaterThan(0);
    expect(Number(row?.actual), '声明的 case_count 与实际行数不符').toBe(Number(row?.case_count));

    // Target 也必须指到自己真实的最新版本，否则页面上的「当前版本」是假的
    const tg = await getPool().query<{ current_version_no: number; max_no: number | null }>(
      `SELECT t.current_version_no,
              (SELECT max(v.version_no) FROM target_versions v WHERE v.target_id = t.id) AS max_no
         FROM targets t WHERE t.id = $1`,
      [fixture.targetId],
    );
    expect(tg.rows[0]?.current_version_no).toBe(tg.rows[0]?.max_no);
  });
});

describe('`B-07`/`B-08` · 收尾必须复原种子', () => {
  it('重放种子后全库回到「只有种子」的状态', async () => {
    await restore();
    await expect(snapshot()).resolves.toEqual(SEEDED);
  });

  it('重放种子后不残留任何不一致', async () => {
    const violations = await allIntegrityViolations();
    expect(violations, describeViolations(violations)).toHaveLength(0);
  });
});
