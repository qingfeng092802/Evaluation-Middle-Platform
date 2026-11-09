-- 0016 · 不可变触发器（17 个）
-- 事实源：docs/facts/database-schema.md §3
--
-- 构成：7 张完全不可变表 × (no_update + no_delete) = 14
--      + eval_runs (guard + no_delete)              =  2
--      + baselines (guard)                          =  1
--                                                   ----
--                                                      17
-- 名单标准答案：src/contracts/src/db-schema.ts 的 TRIGGER_NAMES

-- ---------------------------------------------------------------------------
-- §3.1 通用拒绝函数（UPDATE 与 DELETE 共用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable table: % rows cannot be % ',
    TG_TABLE_NAME, TG_OP
    USING HINT = 'Immutable entity per PRODUCT-OVERVIEW PT-2. Create a new version/run instead.';
END;
$$;

-- ---------------------------------------------------------------------------
-- §3.2 完全不可变表（7 张 × 2 = 14 个触发器）
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'dataset_versions',
    'dataset_cases',
    'target_versions',
    'run_evaluators',
    'eval_case_results',
    'gate_evaluations',
    'case_human_labels'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_no_update BEFORE UPDATE ON %1$s
         FOR EACH ROW EXECUTE FUNCTION reject_mutation();', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_no_delete BEFORE DELETE ON %1$s
         FOR EACH ROW EXECUTE FUNCTION reject_mutation();', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- §3.3 eval_runs — 单向流转 + 终态冻结（2 个触发器）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eval_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  terminal text[] := ARRAY['COMPLETED','PARTIAL_FAILED','FAILED','CANCELLED'];
BEGIN
  -- 终态整行冻结
  IF OLD.status = ANY (terminal) THEN
    RAISE EXCEPTION 'eval_runs % is terminal (%), row is frozen', OLD.id, OLD.status
      USING HINT = 'Create a new EvalRun instead of modifying a finished one.';
  END IF;

  -- 状态只允许前进
  --
  -- ⚠️ 唯一例外：僵尸回收。`reclaim_stale_runs()`（0017 §4.1）必须能把
  -- RUNNING 退回 PENDING，而 §3.3 的合法流转表不含这条边。
  -- 两处事实文档存在冲突（§3.3 状态机 vs §4.1 回收语义 + T-13 验收要求）。
  -- 解法：回收函数在自己的事务里置会话级开关 `eval.allow_reclaim=on`，
  -- guard 仅在该开关打开时放行 RUNNING → PENDING。
  -- 其余路径（含应用层任何写操作）一律拿不到这个放行，状态机严格性不变。
  IF NEW.status <> OLD.status THEN
    IF OLD.status = 'RUNNING' AND NEW.status = 'PENDING'
       AND coalesce(current_setting('eval.allow_reclaim', true), 'off') = 'on' THEN
      RETURN NEW;   -- 僵尸回收专用边
    END IF;

    IF NOT (
         (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING','CANCELLED'))
      OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED','PARTIAL_FAILED','FAILED','CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'illegal status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_eval_runs_guard
  BEFORE UPDATE ON eval_runs
  FOR EACH ROW EXECUTE FUNCTION eval_runs_guard();

CREATE TRIGGER trg_eval_runs_no_delete
  BEFORE DELETE ON eval_runs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- §3.4 baselines — 只允许状态流转（1 个触发器）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION baselines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'NOMINATED' THEN
    RAISE EXCEPTION 'baseline % already decided (%); cannot re-decide', OLD.id, OLD.status;
  END IF;
  IF NEW.status NOT IN ('CONFIRMED','REJECTED') THEN
    RAISE EXCEPTION 'baseline decision must be CONFIRMED or REJECTED, got %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_baselines_guard
  BEFORE UPDATE ON baselines
  FOR EACH ROW EXECUTE FUNCTION baselines_guard();
