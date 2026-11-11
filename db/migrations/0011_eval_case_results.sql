-- 0011 · eval_case_results — 逐条结果（ED-07，不可变）
-- 事实源：docs/facts/database-schema.md §2.11
-- 不可变：是
-- 注意：ck_eval_case_results_ok_score 只单向强制「OK ⇒ 非空」；
--       「非 OK ⇒ 必须 NULL」由应用侧 EvalCaseResult 契约第二条 refine 承担（SPEC-M1 C-3）

CREATE TABLE eval_case_results (
  id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id         uuid           NOT NULL REFERENCES eval_runs   (id) ON DELETE CASCADE,
  dataset_case_id     uuid           NOT NULL REFERENCES dataset_cases (id) ON DELETE RESTRICT,
  case_key            text           NOT NULL,   -- 冗余，避免对齐时多一次 join

  output_text         text,
  output_raw          jsonb,
  retrieval_returned  jsonb,

  status              text           NOT NULL,
  error_message       text,
  score               numeric(10,6),             -- NULL 当 status <> 'OK'
  passed              boolean,
  operator_scores     jsonb,                     -- [{key,kind,score,passed,threshold,weight,reason}]
  judge_reasoning     text,

  latency_ms          integer,
  tokens_in           integer        NOT NULL DEFAULT 0,
  tokens_out          integer        NOT NULL DEFAULT 0,
  cost_target         numeric(18,8)  NOT NULL DEFAULT 0,
  cost_judge          numeric(18,8)  NOT NULL DEFAULT 0,
  cost_total          numeric(18,8)  GENERATED ALWAYS AS (cost_target + cost_judge) STORED,

  created_at          timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT ux_eval_case_results_run_key UNIQUE (eval_run_id, case_key),
  CONSTRAINT ck_eval_case_results_status CHECK (status IN
    ('OK','FAILED','TIMEOUT','PARSE_ERROR','QUOTA_EXCEEDED','SKIPPED')),
  CONSTRAINT ck_eval_case_results_score  CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  CONSTRAINT ck_eval_case_results_ok_score CHECK (status <> 'OK' OR score IS NOT NULL),
  CONSTRAINT ck_eval_case_results_tok    CHECK (tokens_in >= 0 AND tokens_out >= 0)
);

CREATE INDEX ix_eval_case_results_run_score  ON eval_case_results (eval_run_id, score);
CREATE INDEX ix_eval_case_results_run_status ON eval_case_results (eval_run_id, status);
CREATE INDEX ix_eval_case_results_run_latency ON eval_case_results (eval_run_id, latency_ms);
