-- 0015 · case_human_labels — 人工标注留痕（OUT-5，只增不改）
-- 事实源：docs/facts/database-schema.md §2.15
-- 不可变：是（只增不改）
--
-- 为什么独立成表：eval_case_results 完全不可变，而人工标注必然发生在评测之后。
-- 加列 = 给不可变红线开后门；删旧插新 = 篡改评测结果。见 §2.11 的硬冲突说明。

CREATE TABLE case_human_labels (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_case_result_id uuid        NOT NULL REFERENCES eval_case_results (id) ON DELETE RESTRICT,
  label               text        NOT NULL,   -- 如 'retrieval_miss' / 'hallucination' / 'wrong_answer'
  severity            text,                   -- NULL = 未分级
  note                text,
  labeled_by          text        NOT NULL,
  labeled_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_case_human_labels_label_not_blank CHECK (length(btrim(label)) > 0),
  CONSTRAINT ck_case_human_labels_severity CHECK (
    severity IS NULL OR severity IN ('low', 'medium', 'high')
  )
);

CREATE INDEX ix_case_human_labels_result ON case_human_labels (eval_case_result_id, labeled_at DESC);
CREATE INDEX ix_case_human_labels_label  ON case_human_labels (label, labeled_at DESC);
