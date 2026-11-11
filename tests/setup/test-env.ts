/**
 * 测试进程的数据库隔离（`B-03`/`B-04`）。
 *
 * 由 `vitest.config.ts` 的 `setupFiles` 在每个测试文件**之前**加载。
 *
 * 做法只有一件事：把 `process.env.DATABASE_URL` 改写成测试库。
 *
 * 为什么不改测试代码：被测代码（`db/schema/index.ts` 的 `getPool()`、
 * `db/migrate.ts` 的 `databaseUrl()`、`worker/index.ts` 的子进程 env）全部读
 * `process.env.DATABASE_URL`。在这个唯一入口上改写，等于让**所有**真库测试
 * 自动落到独立库，不需要每个 spec 各写一遍，也不会漏掉新加的 spec ——
 * 漏掉一个就等于那个 spec 又跑回 dev 库、又开始和常驻 worker 抢。
 *
 * 注意这里**不改** `TEST_DATABASE_URL` 本身：测试进程内的改写不会外溢到
 * `dev:all`（它是另一个进程，读的是启动时的环境）。
 *
 * ## 必须幂等
 *
 * Vitest 会在同一个 worker 进程里多次加载 setup（收集阶段一次、执行阶段一次，
 * 多文件时每个文件各一次）。第二次进来时 `DATABASE_URL` **已经是**测试库了 ——
 * 此时再和「dev 库」比一次就会自我误报（拿测试库跟测试库比）。所以先判
 * 「是不是已经隔离过」，已隔离就只补 `ensureTestDatabase`。
 */
import {
  assertIsolatedTestDatabase,
  databaseNameOf,
  ensureTestDatabase,
  TEST_DB_SUFFIX,
  testDatabaseUrl,
} from '../../db/test-db.js';
import { databaseUrl } from '../../db/migrate.js';

const current = process.env['DATABASE_URL'];
const alreadyIsolated = current !== undefined && databaseNameOf(current).endsWith(TEST_DB_SUFFIX);

if (!alreadyIsolated) {
  // `databaseUrl()` 自带默认回退（本机没有 `.env`，DATABASE_URL 通常未设置）。
  // 用它与派生结果比较：拿 `undefined` 当基准会把「派生出的测试库」和
  // 「自己」比较，触发自我误报。
  const devUrl = databaseUrl();
  const testUrl = testDatabaseUrl(devUrl);
  // 配错就当场炸：宁可第一秒失败，也不要跑出随机超时。
  assertIsolatedTestDatabase(testUrl, devUrl);
  process.env['DATABASE_URL'] = testUrl;
  process.env['TEST_DATABASE_URL'] = testUrl;
  // 顶层 await：库里没有这个 database 时先建出来。
  await ensureTestDatabase(testUrl);
  // 让「这次测试连的是哪个库」在日志里可见 —— 排查隔离问题时第一眼要看的就是它。
  console.log(`[test-env] DATABASE_URL → ${testUrl}`);
}
