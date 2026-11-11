-- 0008 · evaluators — 全局算子模板（ED-04 的模板侧，P1）
-- 事实源：docs/facts/database-schema.md §2.8
-- 不可变：否
-- M1 为空表：P0 跑批只用内置 key，run_evaluators 存快照

CREATE TABLE evaluators (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text        NOT NULL,
  kind             text        NOT NULL,
  display_name     text        NOT NULL,
  description      text,
  is_builtin       boolean     NOT NULL DEFAULT false,
  version          integer     NOT NULL DEFAULT 1,
  config_schema    jsonb       NOT NULL,
  default_config   jsonb       NOT NULL,
  prompt_template  text,       -- judge 专用
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_evaluators_key UNIQUE (key),
  CONSTRAINT ck_evaluators_kind CHECK (kind IN ('rule', 'judge')),
  CONSTRAINT ck_evaluators_version_pos CHECK (version >= 1),
  CONSTRAINT ck_evaluators_judge_prompt CHECK (kind <> 'judge' OR prompt_template IS NOT NULL)
);
