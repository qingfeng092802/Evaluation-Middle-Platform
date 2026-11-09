-- 0004 · model_providers — 厂商凭证（账号 + 端点）
-- 事实源：docs/facts/database-schema.md §2.4
-- 不可变：否
-- 安全：api_key_ciphertext 永不通过任何 API 返回（WRITE_ONLY_FIELDS）

CREATE TABLE model_providers (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  kind                text        NOT NULL,
  base_url            text,
  api_key_ciphertext  text        NOT NULL,   -- 密文，任何 API 都不返回
  api_key_masked      text        NOT NULL,   -- 形如 'sk-••••3f2a'
  max_concurrency     integer     NOT NULL DEFAULT 4,
  -- 限流：交给 LiteLLM 的 rpm/tpm 参数执行，我方只存配置
  rpm_limit           integer,                -- NULL = 不限（交厂商侧）
  tpm_limit           integer,                -- NULL = 不限
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_model_providers_name UNIQUE (name),
  CONSTRAINT ck_model_providers_kind CHECK (kind IN ('openai_compatible', 'anthropic', 'litellm')),
  CONSTRAINT ck_model_providers_conc CHECK (max_concurrency > 0),
  CONSTRAINT ck_model_providers_rpm  CHECK (rpm_limit IS NULL OR rpm_limit > 0),
  CONSTRAINT ck_model_providers_tpm  CHECK (tpm_limit IS NULL OR tpm_limit > 0)
);
