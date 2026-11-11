-- 0013 · regression_gates — 回归门禁规则（P1）
-- 事实源：docs/facts/database-schema.md §2.13
-- 不可变：否 —— 审计留痕拆到 0014 gate_evaluations

CREATE TABLE regression_gates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  dataset_id   uuid        NOT NULL REFERENCES datasets  (id) ON DELETE RESTRICT,
  target_id    uuid        REFERENCES targets   (id) ON DELETE RESTRICT,   -- NULL = 不限目标
  baseline_id  uuid        REFERENCES baselines (id) ON DELETE RESTRICT,
  condition    jsonb       NOT NULL,   -- {metric:'score_overall'|'pass_rate'|'regression_pct', op:'<'|'>', value:number}
  action       text        NOT NULL DEFAULT 'BLOCK',
  is_active    boolean     NOT NULL DEFAULT true,
  channels     jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- 仅 webhook url，绝无 PAT
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_regression_gates_action CHECK (action IN ('BLOCK','WARN')),
  CONSTRAINT ck_regression_gates_cond   CHECK (jsonb_typeof(condition) = 'object')
);
