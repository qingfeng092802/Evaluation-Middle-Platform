-- 0019 · Fencing token（claim_epoch）与网关调用幂等账本
-- 事实源：docs/facts/database-schema.md §2.9 / §4.1 / §4.2（M2 增补）
-- 对应：SPEC-M2 §1.3（M2-3 / M2-1 均为 Must-have）、Batch 1
--
-- 回滚脚本：`db/migrations/down/0019_claim_epoch.down.sql`
-- （`down/` 子目录不会被 `listMigrationFiles()` 读到，也不会被 `migrate()` 自动执行。）

-- ---------------------------------------------------------------------------
-- §1 · M2-3 Fencing token
-- ---------------------------------------------------------------------------
-- 问题：回收只在「心跳过期」时发生。若原 worker 只是**长时间停顿**
-- （GC / 宿主挂起 / 调度饥饿）而非死亡，它恢复后会继续续写心跳，
-- 把已被别人领走的 run 重新「点亮」——两个 worker 可能同时跑同一条 run。
--
-- 解法：给每次领取分配单调递增的 `claim_epoch`。worker 的所有写入
-- （心跳 / 结果 / 终态）都带 `WHERE claim_epoch = $epoch`，
-- 旧属主的写入自动失效（影响行数 0 ⇒ 立即放弃且不写任何结果）。
ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS claim_epoch bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN eval_runs.claim_epoch IS
  'Fencing token：每次 claim_next_run() 领取时 +1。worker 所有写入带 WHERE claim_epoch = $epoch，旧属主写入自动失效。PENDING（从未领取）为 0。';

-- ---------------------------------------------------------------------------
-- §2 · M2-1 网关调用幂等账本
-- ---------------------------------------------------------------------------
-- 问题：worker 真崩溃时，回收方会重跑崩溃瞬间**在途**的 Case。结果行仍幂等
-- （UNIQUE(eval_run_id, case_key)），但**网关被多调用一次** ⇒ `cost_target`
-- 与实际账单可能不一致。
--
-- 解法：每次网关调用前先尝试「占位」这条幂等键。占位成功（首次）才真正调用并计费；
-- 占位失败（已存在）说明这条 Case 已经被调用过，直接复用上次的用量，不再调用、不再计费。
--
-- 键的派生：`run_id + case_key + attempt_kind`（`target` / `judge`），
-- 由应用层拼成文本写入。**不存明文 Key**，只存派生值。
CREATE TABLE IF NOT EXISTS gateway_idempotency (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 派生的幂等键：`${run_id}:${case_key}:${attempt_kind}`。
  -- 全局唯一 ⇒ 同一 Case 的同一类调用只可能成功占位一次。
  idempotency_key text        NOT NULL,

  eval_run_id     uuid        NOT NULL REFERENCES eval_runs(id),
  case_key        text        NOT NULL,

  -- 调用类别：被测模型 / 裁判模型。分列是为了让「哪一类被重复调用」可查。
  attempt_kind    text        NOT NULL,

  -- 首次调用时写入的用量快照。回收方读到已有行时**直接复用**这份用量，
  -- 不重新调用网关 —— 这是「只计费一次」的物理保证。
  tokens_in       integer     NOT NULL DEFAULT 0,
  tokens_out      integer     NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_gateway_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT ck_gateway_idempotency_kind CHECK (attempt_kind IN ('target', 'judge')),
  CONSTRAINT ck_gateway_idempotency_tokens CHECK (tokens_in >= 0 AND tokens_out >= 0)
);

COMMENT ON TABLE gateway_idempotency IS
  'M2-1 网关调用幂等账本：同一 idempotency_key 只成功占位一次，保证 worker 崩溃重跑时网关不被重复计费。';

-- 按 run 查账（报告里标注「该 run 发生过回收」时用）。
CREATE INDEX IF NOT EXISTS idx_gateway_idempotency_run
  ON gateway_idempotency (eval_run_id);

-- ---------------------------------------------------------------------------
-- §3 · 队列函数：claim_next_run 递增 epoch
-- ---------------------------------------------------------------------------
-- 返回类型保持 `SETOF eval_runs`（0017 的教训：复合类型会在空队列上返回
-- 一行全 NULL，worker 判不出空）。这里只多做一件事：领取时 `claim_epoch + 1`。
CREATE OR REPLACE FUNCTION claim_next_run()
RETURNS SETOF eval_runs
LANGUAGE plpgsql AS $$
DECLARE r eval_runs;
BEGIN
  UPDATE eval_runs
     SET status = 'RUNNING',
         started_at = now(),
         -- M2-3：每次领取递增。旧属主手里的 epoch 从此不再匹配。
         claim_epoch = claim_epoch + 1
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
-- §4 · 回收函数：同步清空 epoch
-- ---------------------------------------------------------------------------
-- 回收把 run 退回 PENDING 时，`claim_epoch` **不回退**（它必须单调递增，
-- 否则旧属主的 epoch 可能重新匹配）。下一次领取会继续 +1。
-- 这里保留 0018 的 `heartbeat_at` 逻辑不动，只补注释说明 epoch 语义。
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
           -- claim_epoch 刻意不回退：它单调递增，旧属主永远拿不回匹配权。
     WHERE status = 'RUNNING'
       -- GREATEST 忽略 NULL：heartbeat_at IS NULL ⇒ 取 started_at（旧行兼容）。
       AND GREATEST(started_at, heartbeat_at) < now() - p_stale_after
    RETURNING id
  )
  SELECT count(*) INTO n FROM stale;

  PERFORM set_config('eval.allow_reclaim', 'off', true);
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- §5 · 不可变约束：幂等账本只增不删；用量允许「一次性回填」
-- ---------------------------------------------------------------------------
-- 为什么**不**加 `no_update`：占位发生在网关调用**之前**（那时还不知道用量），
-- 真实用量必须在调用成功后回填到同一行。若禁止 UPDATE，回填就写不进去，
-- 崩溃后的复用方会读到 0 —— 那是**少计费**，比重复计费更难发现。
--
-- 因此这里的不可变语义是：
--   · **不可删**（`no_delete`）：账本一旦占位就是既成事实；
--   · **可回填一次**（允许 UPDATE，但只允许把用量从 0 改成实际值，且只允许一次）：
--     由 `gateway_idempotency_usage_once` 约束保证「回填后不可再改」。
--
-- 这与 PT-2 的不可变哲学不冲突：PT-2 防的是**历史实体被篡改**；
-- 用量回填是「把一次调用的结果记完」，不是改历史。
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable table: % rows cannot be % ',
    TG_TABLE_NAME, TG_OP
    USING HINT = 'Immutable entity per PRODUCT-OVERVIEW PT-2. Create a new version/run instead.';
END;
$$;

-- 只禁删除。
DROP TRIGGER IF EXISTS trg_gateway_idempotency_no_delete ON gateway_idempotency;
CREATE TRIGGER trg_gateway_idempotency_no_delete
  BEFORE DELETE ON gateway_idempotency
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- 用量回填守卫：只允许「从 0 变成非 0」一次，之后再改一律拒绝。
CREATE OR REPLACE FUNCTION gateway_idempotency_usage_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 已经回填过（非 0）⇒ 不允许再改。
  IF OLD.tokens_in <> 0 OR OLD.tokens_out <> 0 THEN
    RAISE EXCEPTION 'gateway_idempotency usage already recorded (tokens_in=%, tokens_out=%); cannot re-record',
      OLD.tokens_in, OLD.tokens_out
      USING HINT = 'Usage is recorded exactly once per idempotency key. Create a new key instead.';
  END IF;
  -- 只允许「占位 → 回填」这一个方向。
  IF NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.eval_run_id <> OLD.eval_run_id
     OR NEW.case_key <> OLD.case_key
     OR NEW.attempt_kind <> OLD.attempt_kind THEN
    RAISE EXCEPTION 'gateway_idempotency identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gateway_idempotency_usage_once ON gateway_idempotency;
CREATE TRIGGER trg_gateway_idempotency_usage_once
  BEFORE UPDATE ON gateway_idempotency
  FOR EACH ROW EXECUTE FUNCTION gateway_idempotency_usage_once();
