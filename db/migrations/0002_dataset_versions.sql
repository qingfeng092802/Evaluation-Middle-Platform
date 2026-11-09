-- 0002 · dataset_versions — 不可变版本快照（ED-02）
-- 事实源：docs/facts/database-schema.md §2.2
-- 不可变：是（由 0016 的 reject_mutation 触发器兜底）

CREATE TABLE dataset_versions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id      uuid        NOT NULL REFERENCES datasets (id) ON DELETE RESTRICT,
  version_no      integer     NOT NULL,
  schema_version  text        NOT NULL DEFAULT '1',
  case_count      integer     NOT NULL DEFAULT 0,
  content_hash    text        NOT NULL,
  source          text        NOT NULL,
  note            text,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_dataset_versions_no      UNIQUE (dataset_id, version_no),
  CONSTRAINT ck_dataset_versions_no_pos  CHECK (version_no >= 1),
  CONSTRAINT ck_dataset_versions_count   CHECK (case_count >= 0),
  CONSTRAINT ck_dataset_versions_source  CHECK (source IN ('import', 'mine', 'backflow')),
  CONSTRAINT ck_dataset_versions_schema  CHECK (schema_version = '1')   -- 首版锁定
);

CREATE INDEX ix_dataset_versions_dataset_created ON dataset_versions (dataset_id, created_at DESC);

-- 同一数据集内「最近一次内容等价的版本」查找（用于「等价则不新成版」判定）。
-- ⚠️ 刻意非唯一：唯一约束会堵死「内容相同但有意重新成版」（§2.2 的说明）。
CREATE INDEX ix_dataset_versions_dataset_hash
  ON dataset_versions (dataset_id, content_hash);
