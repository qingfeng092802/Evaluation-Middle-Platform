-- 0019 的回滚脚本（`down/` 子目录不会被 `migrate()` 自动执行）
--
-- 与 `0019_claim_epoch.sql` 严格逆序：
--  1. 先删幂等账本的触发器与表（触发器依赖 `reject_mutation()`，函数本身保留）；
--  2. 把 `claim_next_run()` 恢复成 0017/0018 的版本（不写 claim_epoch）；
--  3. 删除 claim_epoch 列；
--  4. 清掉 schema_migrations 中的应用记录，使 up 脚本可再次前滚。
--
-- 验证方式：`tests/claim-epoch.spec.ts` 在影子库上执行「前滚 → 回滚 → 再前滚」。

-- ---- 1. 幂等账本 ----
DROP TRIGGER IF EXISTS trg_gateway_idempotency_usage_once ON gateway_idempotency;
DROP TRIGGER IF EXISTS trg_gateway_idempotency_no_delete ON gateway_idempotency;
DROP FUNCTION IF EXISTS gateway_idempotency_usage_once();
DROP INDEX IF EXISTS idx_gateway_idempotency_run;
DROP TABLE IF EXISTS gateway_idempotency;

-- ---- 2. claim_next_run 恢复为不带 claim_epoch 的版本 ----
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

  IF r.id IS NULL THEN
    RETURN;
  END IF;
  RETURN NEXT r;
END;
$$;

-- ---- 3. 删列 ----
ALTER TABLE eval_runs DROP COLUMN IF EXISTS claim_epoch;

-- ---- 4. 清应用记录 ----
DELETE FROM schema_migrations WHERE file = '0019_claim_epoch.sql';
