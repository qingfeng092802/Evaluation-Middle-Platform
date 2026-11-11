-- 0003 · dataset_cases — 不可变样本（ED-03）
-- 事实源：docs/facts/database-schema.md §2.3
-- 不可变：是

CREATE TABLE dataset_cases (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version_id  uuid        NOT NULL REFERENCES dataset_versions (id) ON DELETE RESTRICT,
  case_key            text        NOT NULL,
  seq                 integer     NOT NULL,
  input               jsonb       NOT NULL,
  reference           jsonb,
  retrieval           jsonb,
  -- 业务标签（难度/业务域/优先级等），只做筛选，不参与打分
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- 跨版本对齐的唯一依据；缺失则 US-009 逐条对比静默错配
  CONSTRAINT ux_dataset_cases_version_key UNIQUE (dataset_version_id, case_key),
  CONSTRAINT ux_dataset_cases_version_seq UNIQUE (dataset_version_id, seq),
  CONSTRAINT ck_dataset_cases_key_not_blank CHECK (length(btrim(case_key)) > 0),
  CONSTRAINT ck_dataset_cases_seq_pos  CHECK (seq >= 0),
  CONSTRAINT ck_dataset_cases_input_obj CHECK (jsonb_typeof(input) = 'object'),
  CONSTRAINT ck_dataset_cases_meta_obj  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX ix_dataset_cases_version_seq ON dataset_cases (dataset_version_id, seq);

-- 业务标签筛选（如「只看难度=hard 的 Case」）
CREATE INDEX ix_dataset_cases_metadata_key
  ON dataset_cases (dataset_version_id, (metadata -> 'difficulty'));

-- 检索算子可行性判定（PG-02 步骤3 阻塞校验的依据）
CREATE INDEX ix_dataset_cases_has_retrieval
  ON dataset_cases (dataset_version_id)
  WHERE retrieval IS NOT NULL;
