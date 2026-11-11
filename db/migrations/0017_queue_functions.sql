-- 0017 · 队列辅助函数（claim_next_run / reclaim_stale_runs）
-- 事实源：docs/facts/database-schema.md §4
--
-- 这两个函数是一对，缺一不可：
--   claim_next_run()   只领 PENDING；
--   reclaim_stale_runs() 把 worker 崩溃留下的 RUNNING 召回。
-- 少了后者，「重启后任务永远卡在 RUNNING」是必然故障（Q-1）。

-- ---------------------------------------------------------------------------
-- 领取下一个待执行运行（多 worker 安全）
-- ---------------------------------------------------------------------------
-- ⚠️ 返回类型必须是 `SETOF eval_runs`，**不是** `eval_runs`。
--
-- `RETURNS eval_runs` 是**复合类型**：没有可领的行时 `RETURN r`（r 全 NULL）
-- 在 `SELECT * FROM claim_next_run()` 里**仍然是 1 行**，只是每个字段都是 NULL。
-- 调用侧 `if (!row) return null` 因此判不出来，worker 会在空队列上无限刷
-- 「领取 run null」。改成 SETOF 后，未赋值时函数返回**零行**，语义才与名字相符。
-- `db/repo/queue.ts` 与 `tests/queue.spec.ts` 两侧都钉住了这一条。
CREATE OR REPLACE FUNCTION claim_next_run()
RETURNS SETOF eval_runs
LANGUAGE plpgsql AS $$
DECLARE r eval_runs;
BEGIN
  UPDATE eval_runs
     SET status = 'RUNNING', started_at = now()
   WHERE id = (
     SELECT id FROM eval_runs
      WHERE status = 'PENDING'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING * INTO r;

  -- 未进入循环体（r 仍为 NULL）时必须返回空集：`RETURN;` 对 SETOF 即「零行」。
  IF r.id IS NULL THEN
    RETURN;
  END IF;
  RETURN NEXT r;
END;
$$;

-- ---------------------------------------------------------------------------
-- §4.1 僵尸任务回收（必需，不是可选）
-- ---------------------------------------------------------------------------
-- 把「RUNNING 但已失联」的运行退回 PENDING，供重新领取。
-- 触发场景：worker 进程被 kill / 容器重启 / 宿主断电。
-- 召回时必须同时把 started_at 置回 NULL，否则下一次回收会把刚领走的新任务误判为僵尸。
CREATE OR REPLACE FUNCTION reclaim_stale_runs(p_stale_after interval)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  -- 僵尸回收是 eval_runs_guard 中 RUNNING → PENDING 的唯一合法来源。
  -- 用会话级开关显式声明意图，避免把这条边开放给任何其他写路径（见 0016 的说明）。
  PERFORM set_config('eval.allow_reclaim', 'on', true);   -- true = 事务级，结束自动复位

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
