-- 0009 · eval_runs — 评测运行（ED-06，终态后不可变）
-- 事实源：docs/facts/database-schema.md §2.9
-- 不可变：终态后是（由 0016 的 eval_runs_guard 触发器兜底）

CREATE TABLE eval_runs (
  id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text           NOT NULL,
  dataset_version_id    uuid           NOT NULL REFERENCES dataset_versions (id) ON DELETE RESTRICT,
  target_version_id     uuid           NOT NULL REFERENCES target_versions  (id) ON DELETE RESTRICT,
  status                text           NOT NULL DEFAULT 'PENDING',
  concurrency           integer        NOT NULL,

  total_cases           integer        NOT NULL DEFAULT 0,
  succeeded_cases       integer        NOT NULL DEFAULT 0,
  failed_cases          integer        NOT NULL DEFAULT 0,
  skipped_cases         integer        NOT NULL DEFAULT 0,

  -- 质量 / 可用性 / 完整性 三分离（OPEN-5）
  score_overall         numeric(10,6),          -- NULL = 无可评样本，禁止用 0 冒充
  pass_rate             numeric(10,6),
  coverage              numeric(10,6),

  latency_p50_ms        integer,
  latency_p95_ms        integer,

  tokens_in_total       bigint         NOT NULL DEFAULT 0,
  tokens_out_total      bigint         NOT NULL DEFAULT 0,

  -- 成本分列（OPEN-3）；cost_total 是生成列，禁止应用侧累加
  cost_target           numeric(18,8)  NOT NULL DEFAULT 0,
  cost_judge            numeric(18,8)  NOT NULL DEFAULT 0,
  cost_total            numeric(18,8)  GENERATED ALWAYS AS (cost_target + cost_judge) STORED,

  config_snapshot       jsonb          NOT NULL,   -- 版本/目标/算子/单价完整快照
  reproducibility       jsonb          NOT NULL,   -- OPEN-4，cache_policy='none'
  runner_version        text           NOT NULL,

  -- 来源与基线引用
  trigger_source        text           NOT NULL DEFAULT 'MANUAL',
  -- 自引用外键：本 run 发起时对比的是哪个 run。
  baseline_run_id       uuid           REFERENCES eval_runs (id) ON DELETE RESTRICT,

  created_by            text           NOT NULL,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  cancel_requested_at   timestamptz,

  CONSTRAINT ck_eval_runs_status CHECK (status IN
    ('PENDING','RUNNING','COMPLETED','PARTIAL_FAILED','FAILED','CANCELLED')),
  CONSTRAINT ck_eval_runs_conc   CHECK (concurrency > 0),
  CONSTRAINT ck_eval_runs_source CHECK (trigger_source IN ('MANUAL','CI_WEBHOOK')),
  CONSTRAINT ck_eval_runs_no_self_baseline CHECK (baseline_run_id IS DISTINCT FROM id),
  CONSTRAINT ck_eval_runs_counts CHECK (
    total_cases >= 0 AND succeeded_cases >= 0 AND failed_cases >= 0 AND skipped_cases >= 0
    AND succeeded_cases + failed_cases + skipped_cases <= total_cases
  ),
  CONSTRAINT ck_eval_runs_score  CHECK (score_overall IS NULL OR (score_overall >= 0 AND score_overall <= 1)),
  CONSTRAINT ck_eval_runs_pass   CHECK (pass_rate     IS NULL OR (pass_rate     >= 0 AND pass_rate     <= 1)),
  CONSTRAINT ck_eval_runs_cov    CHECK (coverage      IS NULL OR (coverage      >= 0 AND coverage      <= 1)),
  -- FAILED 状态必须有覆盖信息且无总分
  CONSTRAINT ck_eval_runs_failed_null_score CHECK (
    status <> 'FAILED' OR score_overall IS NULL
  )
);

CREATE INDEX ix_eval_runs_status_created ON eval_runs (status, created_at DESC);
CREATE INDEX ix_eval_runs_created        ON eval_runs (created_at DESC);
CREATE INDEX ix_eval_runs_ds_version     ON eval_runs (dataset_version_id);
CREATE INDEX ix_eval_runs_target_version ON eval_runs (target_version_id);
-- 队列领取专用
CREATE INDEX ix_eval_runs_pending ON eval_runs (created_at) WHERE status = 'PENDING';
-- 僵尸任务回收：找「RUNNING 且启动已久」的行
CREATE INDEX ix_eval_runs_running_started ON eval_runs (started_at) WHERE status = 'RUNNING';
-- 「某 Run 的对比对象」反查
CREATE INDEX ix_eval_runs_baseline_run ON eval_runs (baseline_run_id) WHERE baseline_run_id IS NOT NULL;
