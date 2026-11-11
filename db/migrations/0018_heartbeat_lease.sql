-- 0018 · 心跳租约（eval_runs.heartbeat_at）
-- 事实源：docs/facts/database-schema.md §2.9 / §4.1
--
-- 背景（#6）：旧版 `reclaim_stale_runs()` 只看 `started_at`。任何耗时超过阈值的
-- **正常** run 都会被另一个 worker 当成僵尸回收并二次执行。行级幂等
-- （`ON CONFLICT (eval_run_id, case_key) DO NOTHING`）挡得住重复行，
-- 挡不住重复的**网关调用** —— 真网关下就是重复计费。
--
-- 方案 A：worker 在处理期间定期续写 `heartbeat_at`；回收判定改为
-- `GREATEST(started_at, heartbeat_at) < now() - p_stale_after`。
-- PostgreSQL 的 `GREATEST` 忽略 NULL，因此旧行（heartbeat_at 为 NULL）
-- 自动回退到 `started_at`，T-13 / T-14 的既有语义原样保留。
--
-- 回滚脚本：`db/migrations/down/0018_heartbeat_lease.down.sql`
-- （`down/` 子目录不会被 `listMigrationFiles()` 读到，也不会被 `migrate()` 自动执行。）

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMENT ON COLUMN eval_runs.heartbeat_at IS
  'worker 心跳（租约续期）。NULL = 尚未心跳，回收时按 started_at 判定。';

-- 回收函数：判定依据改为「最近一次活动时间」
CREATE OR REPLACE FUNCTION reclaim_stale_runs(p_stale_after interval)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  -- 僵尸回收是 eval_runs_guard 中 RUNNING → PENDING 的唯一合法来源。
  PERFORM set_config('eval.allow_reclaim', 'on', true);   -- true = 事务级，结束自动复位

  WITH stale AS (
    UPDATE eval_runs
       SET status = 'PENDING',
           started_at = NULL,
           heartbeat_at = NULL
     WHERE status = 'RUNNING'
       -- GREATEST 忽略 NULL：heartbeat_at IS NULL ⇒ 取 started_at（旧行兼容）。
       -- 两者皆 NULL 时比较结果为 NULL ⇒ 不回收（与 0017 一致）。
       AND GREATEST(started_at, heartbeat_at) < now() - p_stale_after
    RETURNING id
  )
  SELECT count(*) INTO n FROM stale;

  PERFORM set_config('eval.allow_reclaim', 'off', true);
  RETURN n;
END;
$$;
