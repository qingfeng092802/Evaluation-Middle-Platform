/**
 * 测试库隔离（`B-03`/`B-04`）。
 *
 * ## 事故复盘
 *
 * 所有真库测试（`heartbeat-worker` / `api` / `queue` / `seed` / `heartbeat` /
 * `migrations`）原先连的都是 `databaseUrl()` —— 也就是 **dev 库 `eval_platform`**。
 * 而 `scripts/dev-all.ts` 会在同一个库上常驻一个 worker。于是：
 *
 * ```
 * 测试 beforeAll: dropAndRecreateSchema(eval_platform)   ← 把常驻 worker 的表也清了
 * 常驻 worker:    每 200ms 轮询 claim_next_run()
 *                ⇒ 抢走测试刚造的 PENDING run
 *                ⇒ 测试侧「A 领取 run」永远等不到（H-11 超时 15000ms）
 *                ⇒ 同一个 Case 被测试 worker 与常驻 worker 各打一次
 *                ⇒ 网关请求数翻倍（H-10 expected [2,2] to equal [1,1]）
 * ```
 *
 * 断言本身没有错，错的是**测试与常驻进程共用了一个库**。所以修的是环境：
 * 测试一律连 `eval_platform_test`，dev:all 的 worker 连 `eval_platform`，
 * 两个 database 之间没有共享表、没有共享队列，也就没有争抢。
 *
 * ## 为什么是独立 database 而不是独立 schema
 *
 * `dropAndRecreateSchema()` 执行的是 `DROP SCHEMA public CASCADE` —— 它清的就是
 * `public`。若测试与 dev 只隔一个 schema，这个函数仍然会打到 dev 的数据；
 * 而迁移脚本里 `CREATE EXTENSION` / `SET search_path` 之类的写法也会互相牵连。
 * 独立 database 是唯一能保证 `DROP SCHEMA public` 只影响测试的隔离级别。
 *
 * ## 边界如何强制
 *
 * 不是靠约定，靠三处硬约束：
 *  1. `tests/setup/test-env.ts` 在**每个测试进程**启动时把 `process.env.DATABASE_URL`
 *     改写成测试库 —— 被测代码（`getPool()` / `databaseUrl()`）无需任何改动；
 *  2. `assertIsolatedTestDatabase()` 在改写后立刻校验库名不等于 dev 库名，
 *     配错（例如 `TEST_DATABASE_URL` 直接指到 `eval_platform`）当场抛错；
 *  3. `dev:all` 只读 `process.env.DATABASE_URL`，测试进程内的改写不会外溢 ——
 *     常驻 worker 永远停在 dev 库。
 */
import { Client } from 'pg';
import { databaseUrl } from './migrate.js';

/** 测试库 = dev 库名 + 该后缀。 */
export const TEST_DB_SUFFIX = '_test';

/** 从连接串取库名（`postgres://u:p@h:5433/eval_platform` → `eval_platform`）。 */
export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * 解析测试库连接串。
 *
 * 优先级：**显式传入的 baseUrl** > `TEST_DATABASE_URL` > 由 `databaseUrl()` 派生。
 *
 * 显式参数排第一，是为了让「从某个连接串派生」这件事可以被单独测试 ——
 * 否则进程环境里一旦设了 `TEST_DATABASE_URL`，派生逻辑就永远测不到
 * （它被覆盖了），而派生恰恰是默认路径。
 *
 * 派生而不是写死 `127.0.0.1:5433`，是为了让「换一个 PG 实例」时测试自动跟过去 ——
 * 写死会在换端口那天变成「连不上」而不是「连错库」。
 * 已经是 `*_test` 的库名不再叠加后缀，避免 `eval_platform_test_test`。
 */
export function testDatabaseUrl(baseUrl?: string): string {
  if (baseUrl !== undefined && baseUrl !== '') {
    const u = new URL(baseUrl);
    const name = databaseNameOf(baseUrl);
    if (!name.endsWith(TEST_DB_SUFFIX)) u.pathname = `/${name}${TEST_DB_SUFFIX}`;
    return u.toString();
  }

  const explicit = process.env['TEST_DATABASE_URL'];
  if (explicit !== undefined && explicit !== '') return explicit;

  return testDatabaseUrl(databaseUrl());
}

/**
 * 测试库与 dev 库必须是**两个不同的 database**。
 *
 * 这条校验存在的理由很具体：`TEST_DATABASE_URL` 是人手填的，填错一次
 * （复制粘贴成 dev 连接串）就会悄悄退回事故现场 —— 而且症状是随机的超时，
 * 看起来像 flaky test。宁可在进程启动的第一秒就炸。
 */
export function assertIsolatedTestDatabase(testUrl: string, devUrl: string): void {
  const testName = databaseNameOf(testUrl);
  const devName = databaseNameOf(devUrl);
  if (testName === devName) {
    throw new Error(
      `测试库与 dev 库是同一个 database（${testName}）。` +
        '真库测试会 dropAndRecreateSchema()，与 dev:all 的常驻 worker 抢同一个队列 —— ' +
        '这正是 B-03/B-04 的成因。请把 TEST_DATABASE_URL 指向独立的 *_test 库。',
    );
  }
}

/** 把连接串的库名换成 `postgres`（管理库），用于 CREATE DATABASE。 */
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

/**
 * 确保测试库存在（幂等）。
 *
 * `CREATE DATABASE` 不能在事务里跑，也不能带 `IF NOT EXISTS`（PG 不支持），
 * 所以先查 `pg_database` 再建。
 */
export async function ensureTestDatabase(url: string = testDatabaseUrl()): Promise<void> {
  const name = databaseNameOf(url);
  const admin = new Client({ connectionString: adminUrlOf(url) });
  await admin.connect();
  try {
    const res = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM pg_database WHERE datname = $1',
      [name],
    );
    if (res.rows[0]?.n === '0') {
      // 库名来自连接串，用 quote_ident 语义的手工转义；库名已由 URL 解析得到，
      // 不含引号/分号（否则 URL 解析本身就会失败）。
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}
