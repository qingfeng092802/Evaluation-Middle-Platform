/**
 * M2 Batch 1 · 行为级单测：**Fencing Token 脑裂拦截**（M2-3）+ **崩溃重跑幂等**（M2-1）。
 *
 * ## 为什么这两条必须是行为级（真库 + 真 SQL）
 *
 * 这两条防线都**只在数据库里成立**：
 *  - M2-3 靠 `WHERE claim_epoch = $epoch` 让旧属主的写入影响 0 行；
 *  - M2-1 靠 `UNIQUE(idempotency_key)` + `ON CONFLICT DO NOTHING` 让第二次占位失败。
 *
 * 在应用层用内存 map 或 mock 测「是否重复」，测的是我自己的判断逻辑，
 * 而不是「数据库真的拦住了」。`M1-验收记录.md` §0.1 记过一次同型教训：
 * `claim_next_run()` 的复合类型 bug 在单测里全绿，真跑起来 worker 无限刷日志。
 *
 * 因此这里全部走**真 PG 16**（`eval_platform_test`），断言的是**行数与影响行数**。
 *
 * ## 覆盖的两个故障场景
 *
 * 1. **脑裂**：worker A 领取 run（epoch=1）→ 停顿 → A 的心跳过期被回收 →
 *    worker B 领取（epoch=2）→ A 恢复后继续写。
 *    期望：A 的所有写入影响 **0 行**，且**不产生任何结果行**。
 *
 * 2. **崩溃重跑重复计费**：worker A 在网关调用前占位了幂等键，调用成功后崩溃 →
 *    回收 → worker B 重跑同一条 Case。
 *    期望：B 的占位**失败**（`reserved=false`），复用 A 写下的用量，
 *    **不再调用网关、不再计费**。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import {
  claimNextRun,
  reclaimStaleRuns,
  touchHeartbeat,
  updateRunWithFence,
} from '../db/repo/queue.js';
import {
  gatewayIdempotencyKey,
  recordGatewayUsage,
  reserveGatewayCall,
} from '../db/repo/gatewayIdempotency.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { insertPendingRun, restoreSeed } from './support/fixtures.js';

const DB_URL = process.env['DATABASE_URL'];

const q = async <T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> => (await getPool().query<T>(text, params)).rows;

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
  await resetDatabase(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(DB_URL);
  await closeDb();
  await connect(DB_URL)
    .then((c) => c.end())
    .catch(() => undefined);
});

// ---------------------------------------------------------------------------
// M2-3 · Fencing Token 脑裂拦截
// ---------------------------------------------------------------------------

describe('M2-3 · Fencing Token：旧属主的写入必须失效', () => {
  it('claim_next_run 每次领取把 claim_epoch +1', async () => {
    const { runId } = await insertPendingRun('fence');

    // 先确认夹具真的落到了「当前连接池可见的库里」——
    // `dropAndRecreateSchema` 会重连，若池子陈旧，插入与领取会落在不同的库上，
    // 症状是「insert 成功但 claim 返回 null」，极易被误读成 fence 逻辑坏了。
    const [before] = await q<{ id: string; status: string; claim_epoch: string }>(
      `SELECT id, status, claim_epoch FROM eval_runs WHERE id = $1`,
      [runId],
    );
    expect(before, '夹具行必须对当前连接池可见').toBeDefined();
    expect(before?.status).toBe('PENDING');
    expect(Number(before?.claim_epoch), '新行 claim_epoch 必须为 0').toBe(0);

    const first = await claimNextRun();
    // 分两步断言：先确认「领到了」，再确认「领的是哪条」。
    // 合成一条 `expect(first?.id).toBe(runId)` 时，`null` 与「id 不对」都报
    // `expected undefined to be <uuid>`，看不出根因。
    expect(first, '必须领到一条 run（返回 null 说明函数无行或仓储层取不到）').not.toBeNull();
    expect(JSON.stringify(first), `claimNextRun 实际返回：${JSON.stringify(first)}`).toContain(runId);
    expect(first?.claimEpoch).toBe(1);

    // 回收后退回 PENDING，再领取 ⇒ epoch 继续递增（不回退）。
    //
    // ⚠️ 必须把 `started_at` 与 `heartbeat_at` **都**置旧：回收判据是
    // `GREATEST(started_at, heartbeat_at) < now() - stale_after`。
    // 只置 heartbeat_at 时 `started_at = now()`（刚领取时写入）仍会把它救回来，
    // 回收返回 0，第二次领取自然拿不到行 —— 这是夹具的问题，不是 fence 的问题。
    await q(
      `UPDATE eval_runs
          SET heartbeat_at = now() - interval '1 hour',
              started_at   = now() - interval '1 hour'
        WHERE id = $1`,
      [runId],
    );
    const reclaimed = await reclaimStaleRuns('1 second');
    expect(reclaimed, '心跳与开始时间都过期后必须被回收').toBe(1);

    const second = await claimNextRun();
    expect(second?.id).toBe(runId);
    expect(second?.claimEpoch).toBe(2);
  });

  it('脑裂：A 领取 → 被回收 → B 领取 → A 的心跳与终态写入影响 0 行', async () => {
    const { runId } = await insertPendingRun('split');

    // A 领取（epoch=1）
    const a = await claimNextRun();
    expect(a?.claimEpoch).toBe(1);

    // A 停顿到心跳过期，被回收；B 重新领取（epoch=2）
    // `started_at` 与 `heartbeat_at` 都要置旧（回收判据取 GREATEST）。
    await q(
      `UPDATE eval_runs
          SET heartbeat_at = now() - interval '1 hour',
              started_at   = now() - interval '1 hour'
        WHERE id = $1`,
      [runId],
    );
    const reclaimed = await reclaimStaleRuns('1 second');
    expect(reclaimed).toBe(1);

    const b = await claimNextRun();
    expect(b?.claimEpoch).toBe(2);

    // ★ A 恢复后继续写 —— 全部必须影响 0 行
    const aHeartbeatOk = await touchHeartbeat(runId, a?.claimEpoch ?? 0);
    expect(aHeartbeatOk, 'A 的心跳必须被 fence 拦住').toBe(false);

    const aFinishOk = await updateRunWithFence(
      runId,
      a?.claimEpoch ?? 0,
      `status = 'COMPLETED', finished_at = now()`,
      [],
    );
    expect(aFinishOk, 'A 的终态写入必须被 fence 拦住').toBe(false);

    // B 的写入则必须成功
    const bHeartbeatOk = await touchHeartbeat(runId, b?.claimEpoch ?? 0);
    expect(bHeartbeatOk, 'B 是当前属主，心跳必须成功').toBe(true);

    // 库里的状态没有被 A 改坏
    const [row] = await q<{ status: string; claim_epoch: string }>(
      `SELECT status, claim_epoch FROM eval_runs WHERE id = $1`,
      [runId],
    );
    expect(row?.status).toBe('RUNNING');
    expect(Number(row?.claim_epoch)).toBe(2);
  });

  it('脑裂：A 的写入不会产生任何 eval_case_results 行', async () => {
    const { runId } = await insertPendingRun('norows');

    const a = await claimNextRun();
    await q(
      `UPDATE eval_runs
          SET heartbeat_at = now() - interval '1 hour',
              started_at   = now() - interval '1 hour'
        WHERE id = $1`,
      [runId],
    );
    await reclaimStaleRuns('1 second');
    await claimNextRun(); // B 领取

    // A 尝试写结果 —— 应用层的做法是「先 fence 检查，再写结果」。
    const fenceOk = await updateRunWithFence(
      runId,
      a?.claimEpoch ?? 0,
      `heartbeat_at = now()`,
      [],
    );
    expect(fenceOk).toBe(false);

    const rows = await q(`SELECT id FROM eval_case_results WHERE eval_run_id = $1`, [runId]);
    expect(rows, 'A 被 fence 拦住后不得产生结果行').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M2-1 · 崩溃重跑幂等账本
// ---------------------------------------------------------------------------

describe('M2-1 · 幂等账本：同一 Case 的同一类调用只计费一次', () => {
  it('首次占位成功，第二次占位失败并复用上次用量', async () => {
    const { runId } = await insertPendingRun('idem');
    const caseKey = 'case-0001';

    // A：占位 → 调用网关 → 回填用量
    const first = await reserveGatewayCall(runId, caseKey, 'target');
    expect(first.reserved, '首次必须占位成功').toBe(true);
    await recordGatewayUsage(runId, caseKey, 'target', 120, 80);

    // B（崩溃重跑）：占位必须失败，且读回 A 的用量
    const second = await reserveGatewayCall(runId, caseKey, 'target');
    expect(second.reserved, '重跑必须占位失败（不重复调用网关）').toBe(false);
    expect(second.tokensIn, '必须复用上次用量，而不是 0').toBe(120);
    expect(second.tokensOut).toBe(80);
  });

  it('不同 attemptKind 各自独立（target 与 judge 不互相占用）', async () => {
    const { runId } = await insertPendingRun('kinds');
    const caseKey = 'case-0002';

    const t = await reserveGatewayCall(runId, caseKey, 'target');
    const j = await reserveGatewayCall(runId, caseKey, 'judge');
    expect(t.reserved).toBe(true);
    expect(j.reserved, 'judge 是另一类调用，必须能独立占位').toBe(true);
  });

  it('幂等键按 run + case + kind 派生，不同 run 不串号', async () => {
    const a = await insertPendingRun('runA');
    const b = await insertPendingRun('runB');

    const ra = await reserveGatewayCall(a.runId, 'case-x', 'target');
    const rb = await reserveGatewayCall(b.runId, 'case-x', 'target');
    expect(ra.reserved).toBe(true);
    expect(rb.reserved, '不同 run 的同名 case 必须各自占位').toBe(true);

    expect(gatewayIdempotencyKey(a.runId, 'case-x', 'target')).not.toBe(
      gatewayIdempotencyKey(b.runId, 'case-x', 'target'),
    );
  });

  it('用量回填只能一次：二次回填被数据库拒绝（不是应用层约定）', async () => {
    const { runId } = await insertPendingRun('once');
    const caseKey = 'case-0003';

    await reserveGatewayCall(runId, caseKey, 'target');
    await recordGatewayUsage(runId, caseKey, 'target', 100, 50);

    // ★ 二次回填必须被触发器拒绝
    await expect(
      recordGatewayUsage(runId, caseKey, 'target', 999, 999),
    ).rejects.toThrow(/usage already recorded/);
  });

  it('账本不可删（no_delete 触发器）', async () => {
    const { runId } = await insertPendingRun('nodelete');
    await reserveGatewayCall(runId, 'case-0004', 'target');

    await expect(
      q(`DELETE FROM gateway_idempotency WHERE eval_run_id = $1`, [runId]),
    ).rejects.toThrow(/immutable table/);
  });

  it('崩溃重跑场景：网关调用次数 == 唯一幂等键数（不重复计费）', async () => {
    const { runId } = await insertPendingRun('norepeat');

    // 模拟 3 条 Case，每条各跑两次（第一次崩了，第二次重跑）
    let gatewayCalls = 0;
    for (const caseKey of ['c1', 'c2', 'c3']) {
      // 第一轮
      const r1 = await reserveGatewayCall(runId, caseKey, 'target');
      if (r1.reserved) {
        gatewayCalls += 1;
        await recordGatewayUsage(runId, caseKey, 'target', 10, 5);
      }
      // 第二轮（崩溃重跑）
      const r2 = await reserveGatewayCall(runId, caseKey, 'target');
      if (r2.reserved) {
        gatewayCalls += 1;
        await recordGatewayUsage(runId, caseKey, 'target', 10, 5);
      }
    }

    expect(gatewayCalls, '3 条 Case 只应调用网关 3 次').toBe(3);

    const [row] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM gateway_idempotency WHERE eval_run_id = $1`,
      [runId],
    );
    expect(Number(row?.n), '账本行数 == 唯一幂等键数').toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Batch 1 准出条件：影子库「前滚 → 回滚 → 再前滚」
// ---------------------------------------------------------------------------
// 与 M1 `0018` 的 `H-03` 同法（`tests/heartbeat.spec.ts`）。准出条件原文：
// 「`0019+` 迁移实跑通过（**影子库前滚 + 回滚验证**，与 M1 `0018` 同法）」。
//
// 本用例钉住的是**回滚的结果**，不是 down 脚本内部的语句顺序：
//   - `claim_epoch` 列消失、`gateway_idempotency` 表消失；
//   - `schema_migrations` 的应用记录被清掉（否则再前滚会被判定「已应用」而跳过）；
//   - `claim_next_run()` 的定义文本里不再出现 `claim_epoch`；
//   - 再前滚能把列与函数都恢复。
//
// 最后一条靠 `pg_get_functiondef` 比对文本，是**有检验力**的：变异实验（把
// 「恢复函数」这一步整段删掉，只留删列）会让它变红 —— 函数体仍引用 `claim_epoch`。
//
// ⚠️ 但**语句顺序**（先删列还是先恢复函数）不被钉住，也钉不住：PostgreSQL 的
// `CREATE OR REPLACE FUNCTION` **创建时不校验 plpgsql 体里引用的列**（函数体在
// 调用时才解析）。实测把「删列」挪到「恢复函数」之前，本用例仍全绿。要真正
// 验证顺序，得在回滚后**调用一次** `claim_next_run()`——但那需要一个 PENDING 行，
// 且报错信息是运行期错误而非创建期错误，收益低于成本，故此处不做。

describe('Batch 1 准出 · down 脚本：影子库前滚 → 回滚 → 再前滚', () => {
  function shadowAdminUrl(): string {
    const u = new URL(DB_URL ?? '');
    u.pathname = '/postgres';
    return u.toString();
  }

  function shadowUrl(name: string): string {
    const u = new URL(DB_URL ?? '');
    u.pathname = `/${name}`;
    return u.toString();
  }

  it('回滚后 claim_epoch 与账本表消失，函数回到无 epoch 版本，再前滚可恢复', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { MIGRATIONS_DIR, listMigrationFiles } = await import('../db/migrate.js');
    const { Client } = await import('pg');

    const downFile = join(MIGRATIONS_DIR, 'down', '0019_claim_epoch.down.sql');
    const upFile = join(MIGRATIONS_DIR, '0019_claim_epoch.sql');

    // down 脚本不能被 migrate() 自动执行（否则每次迁移都自我回滚）
    expect(await listMigrationFiles()).not.toContain('0019_claim_epoch.down.sql');

    const dbName = `eval_shadow_epoch_${Date.now()}`;
    const admin = new Client({ connectionString: shadowAdminUrl() });
    await admin.connect();
    let shadow: InstanceType<typeof Client> | null = null;
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      shadow = new Client({ connectionString: shadowUrl(dbName) });
      await shadow.connect();

      // ---- 前滚 ----
      await migrate(shadowUrl(dbName));
      const before = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_name = 'eval_runs' AND column_name = 'claim_epoch'`,
      );
      expect(before.rows[0]?.n, '前滚后 claim_epoch 必须存在').toBe('1');
      const tblBefore = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables
          WHERE table_name = 'gateway_idempotency'`,
      );
      expect(tblBefore.rows[0]?.n, '前滚后账本表必须存在').toBe('1');

      // ---- 回滚 ----
      await shadow.query(await readFile(downFile, 'utf8'));

      const after = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_name = 'eval_runs' AND column_name = 'claim_epoch'`,
      );
      expect(after.rows[0]?.n, '回滚后 claim_epoch 必须消失').toBe('0');
      const tblAfter = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables
          WHERE table_name = 'gateway_idempotency'`,
      );
      expect(tblAfter.rows[0]?.n, '回滚后账本表必须消失').toBe('0');

      // 应用记录必须清掉，否则再前滚会被 migrate() 判定为「已应用」而跳过
      const applied = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM schema_migrations WHERE file = '0019_claim_epoch.sql'`,
      );
      expect(applied.rows[0]?.n, '回滚后必须清掉应用记录').toBe('0');

      // 回滚后的领取函数必须回到「不带 claim_epoch」的版本。
      // 用 pg_get_functiondef 直接比对定义文本：影子库里没有业务数据，
      // 调一次函数也验证不了 epoch 有没有被写。
      const fn = await shadow.query<{ def: string }>(
        `SELECT pg_get_functiondef('claim_next_run()'::regprocedure) AS def`,
      );
      expect(fn.rows[0]?.def, '回滚后函数不得再引用 claim_epoch').not.toContain('claim_epoch');

      // ---- 再前滚 ----
      await shadow.query(await readFile(upFile, 'utf8'));
      const again = await shadow.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_name = 'eval_runs' AND column_name = 'claim_epoch'`,
      );
      expect(again.rows[0]?.n, '再前滚后 claim_epoch 必须回来').toBe('1');
      const fnAgain = await shadow.query<{ def: string }>(
        `SELECT pg_get_functiondef('claim_next_run()'::regprocedure) AS def`,
      );
      expect(fnAgain.rows[0]?.def, '再前滚后函数必须重新递增 epoch').toContain('claim_epoch');
    } finally {
      if (shadow) await shadow.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  }, 60_000);
});
