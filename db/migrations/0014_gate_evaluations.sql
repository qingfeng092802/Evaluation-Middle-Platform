-- 0014 · gate_evaluations — 门禁执行留痕（P1，不可变）
-- 事实源：docs/facts/database-schema.md §2.14
-- 不可变：是

CREATE TABLE gate_evaluations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id     uuid        NOT NULL REFERENCES regression_gates (id) ON DELETE CASCADE,
  eval_run_id uuid        NOT NULL REFERENCES eval_runs         (id) ON DELETE RESTRICT,
  passed      boolean     NOT NULL,
  detail      jsonb       NOT NULL,   -- {metric, baseline_value, current_value, delta, op, value}
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_gate_evaluations_gate_created ON gate_evaluations (gate_id, created_at DESC);
CREATE INDEX ix_gate_evaluations_run          ON gate_evaluations (eval_run_id);
