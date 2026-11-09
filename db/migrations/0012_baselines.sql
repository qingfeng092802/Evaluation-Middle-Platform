-- 0012 · baselines — 基线认定（ED-08，BL-1…BL-4）
-- 事实源：docs/facts/database-schema.md §2.12
-- 不可变：否（仅状态可流转，由 0016 的 baselines_guard 兜底）

CREATE TABLE baselines (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id    uuid        NOT NULL REFERENCES datasets  (id) ON DELETE RESTRICT,
  eval_run_id   uuid        NOT NULL REFERENCES eval_runs (id) ON DELETE RESTRICT,
  status        text        NOT NULL DEFAULT 'NOMINATED',
  note          text,
  nominated_by  text        NOT NULL,
  nominated_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    text,
  decided_at    timestamptz,

  CONSTRAINT ck_baselines_status CHECK (status IN ('NOMINATED','CONFIRMED','REJECTED')),
  CONSTRAINT ck_baselines_decision CHECK (
    status = 'NOMINATED' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX ix_baselines_dataset_status ON baselines (dataset_id, status);

-- ★ 每个评测集至多一个 CONFIRMED 基线（BL-1 的数据库级硬保证）
CREATE UNIQUE INDEX ux_baselines_one_confirmed
  ON baselines (dataset_id)
  WHERE status = 'CONFIRMED';
