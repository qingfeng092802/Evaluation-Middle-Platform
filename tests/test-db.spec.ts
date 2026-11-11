/**
 * 测试库隔离的回归（`B-03`/`B-04`）。
 *
 * ## 事故
 *
 * 独立验收跑全量时，`heartbeat-worker.spec.ts` 的 H-10/H-11 会间歇性失败：
 *
 * ```
 * H-10  expected [ 2, 2 ] to deeply equal [ 1, 1 ]     ← 网关被打了两次
 * H-11  超时 15000ms 未等到：A 领取 run                 ← run 被别人抢走
 * ```
 *
 * 断言没有错。错在测试与 `dev:all` 的常驻 worker 连的是**同一个库**
 * `eval_platform`：测试刚插入的 PENDING run，被常驻 worker 先领走；
 * 测试自己起的 worker 与常驻 worker 各跑一遍同一个 Case ⇒ 网关请求翻倍。
 *
 * ## 修法
 *
 * 测试一律连独立库 `eval_platform_test`（`tests/setup/test-env.ts` 改写
 * `DATABASE_URL`），dev:all 的 worker 停在 `eval_platform`，两个 database
 * 之间没有共享队列，也就没有争抢。**断言一个字没改。**
 *
 * 这个 spec 锁住三件事：
 *  1. 派生规则正确（换实例自动跟随、不重复叠加后缀、显式覆盖优先）；
 *  2. 配错（测试库 == dev 库）必须当场抛错，而不是跑出随机超时；
 *  3. **本进程真的被改写到了测试库** —— 这条是对 `setupFiles` 接线的验证，
 *     把 setup 摘掉它就会红（行为级 RED，不是「模块不存在」那种弱 RED）。
 */
import { describe, expect, it } from 'vitest';
import {
  assertIsolatedTestDatabase,
  databaseNameOf,
  TEST_DB_SUFFIX,
  testDatabaseUrl,
} from '../db/test-db.js';
import { databaseUrl } from '../db/migrate.js';

const DEV_URL = 'postgres://eval:eval_local_dev_only@127.0.0.1:5433/eval_platform';

describe('testDatabaseUrl · 由 dev 连接串派生测试库', () => {
  it('库名加 `_test` 后缀，host/port/凭据原样保留', () => {
    const u = new URL(testDatabaseUrl(DEV_URL));
    expect(u.pathname).toBe('/eval_platform_test');
    expect(u.port).toBe('5433');
    expect(u.hostname).toBe('127.0.0.1');
  });

  it('换 PG 实例时自动跟随，不写死 5433', () => {
    const u = new URL(testDatabaseUrl('postgres://eval:pw@10.0.0.9:6543/eval_platform'));
    expect(u.port).toBe('6543');
    expect(u.hostname).toBe('10.0.0.9');
    expect(u.pathname).toBe('/eval_platform_test');
  });

  it('已经是 `_test` 的库名不再叠加后缀（避免 eval_platform_test_test）', () => {
    expect(databaseNameOf(testDatabaseUrl('postgres://eval:pw@h:5433/eval_platform_test'))).toBe(
      'eval_platform_test',
    );
  });

  it('显式 TEST_DATABASE_URL 优先于派生', () => {
    const prev = process.env['TEST_DATABASE_URL'];
    process.env['TEST_DATABASE_URL'] = 'postgres://eval:pw@127.0.0.1:5433/eval_platform_ci';
    try {
      // 不传 baseUrl 才走 env；传了 baseUrl 就是显式派生（见下一条）。
      expect(databaseNameOf(testDatabaseUrl())).toBe('eval_platform_ci');
    } finally {
      if (prev === undefined) delete process.env['TEST_DATABASE_URL'];
      else process.env['TEST_DATABASE_URL'] = prev;
    }
  });

  it('后缀常量与文档口径一致', () => {
    expect(TEST_DB_SUFFIX).toBe('_test');
  });
});

describe('assertIsolatedTestDatabase · 配错必须当场炸', () => {
  it('测试库与 dev 库同名 ⇒ 抛错，并点名 B-03/B-04', () => {
    expect(() => assertIsolatedTestDatabase(DEV_URL, DEV_URL)).toThrow(/B-03\/B-04/);
  });

  it('不同 database ⇒ 放行', () => {
    expect(() =>
      assertIsolatedTestDatabase('postgres://e:p@h:5433/eval_platform_test', DEV_URL),
    ).not.toThrow();
  });
});

describe('setupFiles 接线 · 本进程必须已经落在测试库', () => {
  it('databaseUrl() 指向 *_test，不是 dev 库', () => {
    const name = databaseNameOf(databaseUrl());
    expect(name.endsWith(TEST_DB_SUFFIX)).toBe(true);
    expect(name).not.toBe(databaseNameOf(DEV_URL));
  });

  it('测试库确实与 dev 库是不同 database（隔离成立）', () => {
    expect(() => assertIsolatedTestDatabase(databaseUrl(), DEV_URL)).not.toThrow();
  });
});
