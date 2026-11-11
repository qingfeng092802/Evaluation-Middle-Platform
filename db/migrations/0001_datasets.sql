-- 0001 · datasets — 评测集容器（ED-01）
-- 事实源：docs/facts/database-schema.md §2.1
-- 不可变：否（名称 / 描述可变）

CREATE TABLE datasets (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  description   text,
  workspace_id  text        NOT NULL DEFAULT 'default',   -- 预留，首版不启用权限
  owner_id      text        NOT NULL,                     -- 预留
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_datasets_workspace_name UNIQUE (workspace_id, name),
  CONSTRAINT ck_datasets_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX ix_datasets_created_at ON datasets (created_at DESC);
