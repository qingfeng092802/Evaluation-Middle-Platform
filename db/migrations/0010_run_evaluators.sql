-- 0010 · run_evaluators — 算子快照（ED-04 的实例侧，不可变）
-- 事实源：docs/facts/database-schema.md §2.10
-- 不可变：是
-- 这是 PT-1 能否兑现的关键表：模板改版不影响历史 EvalRun

CREATE TABLE run_evaluators (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id       uuid          NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  evaluator_key     text          NOT NULL,
  evaluator_version integer       NOT NULL,
  kind              text          NOT NULL,
  config            jsonb         NOT NULL,   -- 快照后的完整参数，不引用模板
  weight            numeric(6,4)  NOT NULL DEFAULT 1,
  pass_threshold    numeric(10,6),
  order_index       integer       NOT NULL,

  CONSTRAINT ux_run_evaluators_key   UNIQUE (eval_run_id, evaluator_key),
  CONSTRAINT ck_run_evaluators_kind  CHECK (kind IN ('rule', 'judge')),
  CONSTRAINT ck_run_evaluators_w     CHECK (weight >= 0),
  CONSTRAINT ck_run_evaluators_order CHECK (order_index >= 0)
);

CREATE INDEX ix_run_evaluators_run_order ON run_evaluators (eval_run_id, order_index);
