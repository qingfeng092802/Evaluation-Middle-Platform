-- 0018 的回滚脚本（`down/` 子目录不会被 `migrate()` 自动执行）
--
-- 与 `0018_heartbeat_lease.sql` 严格逆序：
--  1. 先把 `reclaim_stale_runs()` 恢复成 0017 的判定（只看 started_at），
--     否则删列后函数引用不存在的列会直接报错；
--  2. 删除 heartbeat_at 列；
--  3. 清掉 schema_migrations 中的应用记录，使 up 脚本可再次前滚。
--
-- 验证方式：`tests/heartbeat.spec.ts` H-03 在影子库上执行「前滚 → 回滚 → 再前滚」。

CREATE OR REPLACE FUNCTION reclaim_stale_runs(p_stale_after interval)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('eval.allow_reclaim', 'on', true);

  WITH stale AS (
    UPDATE eval_runs
       SET status = 'PENDING',
           started_at = NULL
     WHERE status = 'RUNNING'
       AND started_at IS NOT NULL
       AND started_at < now() - p_stale_after
    RETURNING id
  )
  SELECT count(*) INTO n FROM stale;

  PERFORM set_config('eval.allow_reclaim', 'off', true);
  RETURN n;
END;
$$;

ALTER TABLE eval_runs DROP COLUMN IF EXISTS heartbeat_at;

DELETE FROM schema_migrations WHERE file = '0018_heartbeat_lease.sql';
