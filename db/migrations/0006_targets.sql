-- 0006 · targets — 待测目标容器（ED-05）
-- 事实源：docs/facts/database-schema.md §2.6
-- 不可变：否

CREATE TABLE targets (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text        NOT NULL,
  kind               text        NOT NULL,
  current_version_no integer     NOT NULL DEFAULT 0,
  workspace_id       text        NOT NULL DEFAULT 'default',
  owner_id           text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_targets_workspace_name UNIQUE (workspace_id, name),
  CONSTRAINT ck_targets_kind CHECK (kind IN ('t1_prompt', 't2_http')),
  CONSTRAINT ck_targets_cur_ver CHECK (current_version_no >= 0)
);
