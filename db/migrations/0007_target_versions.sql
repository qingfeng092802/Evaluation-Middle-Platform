-- 0007 · target_versions — 不可变目标版本（ED-05）
-- 事实源：docs/facts/database-schema.md §2.7
-- 不可变：是
-- 关键：ck_target_versions_t1/t2 保证 T1 / T2 字段不可互相污染

CREATE TABLE target_versions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id               uuid        NOT NULL REFERENCES targets (id) ON DELETE RESTRICT,
  version_no              integer     NOT NULL,
  kind                    text        NOT NULL,

  -- T1 平台内执行（P0）
  model_provider_id       uuid        REFERENCES model_providers (id) ON DELETE RESTRICT,
  model_id                text,
  prompt_template         text,
  temperature             numeric(3,2),
  max_tokens              integer,
  params                  jsonb,

  -- T2 外部 HTTP 回调（P1）
  endpoint_url            text,
  auth_header_ciphertext  text,      -- 密文，任何响应都不返回
  request_mapping         jsonb,
  response_mapping        jsonb,

  created_by              text        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_target_versions_no UNIQUE (target_id, version_no),
  CONSTRAINT ck_target_versions_no_pos CHECK (version_no >= 1),
  CONSTRAINT ck_target_versions_kind   CHECK (kind IN ('t1_prompt', 't2_http')),

  -- T1 必填字段完整
  CONSTRAINT ck_target_versions_t1 CHECK (
    kind <> 't1_prompt' OR (
      model_provider_id IS NOT NULL AND
      model_id IS NOT NULL AND
      prompt_template IS NOT NULL AND
      temperature IS NOT NULL AND
      max_tokens IS NOT NULL
    )
  ),
  -- T2 必填字段完整
  CONSTRAINT ck_target_versions_t2 CHECK (
    kind <> 't2_http' OR (
      endpoint_url IS NOT NULL AND
      request_mapping IS NOT NULL AND
      response_mapping IS NOT NULL
    )
  ),
  CONSTRAINT ck_target_versions_temp CHECK (temperature IS NULL OR (temperature >= 0 AND temperature <= 2)),
  CONSTRAINT ck_target_versions_maxtok CHECK (max_tokens IS NULL OR max_tokens > 0)
);
