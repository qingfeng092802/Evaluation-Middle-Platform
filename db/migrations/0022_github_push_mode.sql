-- 0022 · github_integrations / webhook_deliveries / pr_trigger_rules — M5 推入模式数据底座
-- 事实源：docs/Spec/SPEC-M5.md §2.2 / §2.3（Q1=方案 A、Q2=只做 GitHub，2026-11-19 裁定）
-- 不可变：webhook_deliveries **是**（重放拒绝的物理载体，delivery 只追加）；
--         github_integrations / pr_trigger_rules **否**（可编辑配置）
-- 安全：private_key_ct / pat_ciphertext 为 AES-256-GCM 密文（v1: 前缀，provider-key-cipher
--       同格式）；webhook_secret 仅用于 HMAC 校验，**读取契约只有布尔位，永不出口**
-- 互斥：GitHub App（private_key_ct）与 PAT（pat_ciphertext）二选一——Q1 裁定 M5 只实现 App，
--       PAT 列保留为 GHES 降级备选（Q1 裁定：互斥 CHECK 保留）

CREATE TABLE github_integrations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  kind            text        NOT NULL DEFAULT 'github_app',
  app_id          text,                       -- 方案 A；方案 B（PAT）为 NULL
  installation_id text,                       -- 方案 A
  private_key_ct  text,                       -- 方案 A：PEM 密文（v1: 前缀）
  pat_ciphertext  text,                       -- 方案 B：PAT 密文（与 A 互斥）
  webhook_secret  text        NOT NULL,       -- HMAC 校验密钥；永不出 API（读取只有布尔位）
  repos           jsonb       NOT NULL DEFAULT '[]',   -- [{owner, repo}]
  is_active       boolean     NOT NULL DEFAULT true,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_github_integrations_kind CHECK (kind IN ('github_app')),
  CONSTRAINT ck_github_integrations_cred CHECK (
    (private_key_ct IS NOT NULL AND pat_ciphertext IS NULL)
    OR (private_key_ct IS NULL AND pat_ciphertext IS NOT NULL)
  )
);

CREATE TABLE webhook_deliveries (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id       text        NOT NULL,   -- X-GitHub-Delivery GUID；UNIQUE 即重放拒绝的物理载体
  integration_id    uuid        NOT NULL REFERENCES github_integrations (id) ON DELETE CASCADE,
  event             text        NOT NULL,   -- 'pull_request' 等
  signature_verified boolean    NOT NULL,
  processed_status  text        NOT NULL,   -- TRIGGERED / SKIPPED_CLOSED / SKIPPED_UNBOUND / DEDUPED / REJECTED_SIGNATURE
  run_id            uuid        REFERENCES eval_runs (id),   -- 无 ON DELETE：eval_runs 本身不可删（IM 系）
  payload_summary   jsonb       NOT NULL,   -- 白名单摘要（repo/pr 号/sha/action），不落全量载荷
  received_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_webhook_deliveries_delivery UNIQUE (delivery_id),
  CONSTRAINT ck_webhook_deliveries_status CHECK (processed_status IN
    ('TRIGGERED','SKIPPED_CLOSED','SKIPPED_UNBOUND','DEDUPED','REJECTED_SIGNATURE'))
);

CREATE INDEX ix_webhook_deliveries_integration ON webhook_deliveries (integration_id, received_at DESC);

-- 不可变：delivery 一经写入不 Update / Delete（重放 = 读到既有行返回 DEDUPED）
CREATE FUNCTION reject_webhook_delivery_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'webhook_deliveries % is immutable (replay handling reads the existing row)', OLD.id;
END;
$$;

CREATE TRIGGER trg_webhook_deliveries_immutable
  BEFORE UPDATE OR DELETE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_webhook_delivery_mutation();

CREATE TABLE pr_trigger_rules (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid        NOT NULL REFERENCES github_integrations (id) ON DELETE CASCADE,
  repo_full_name  text        NOT NULL,   -- 'owner/repo'
  target_branch   text,                       -- 策略③：目标分支（精确匹配；M5 Q4 裁定不做通配）
  path_globs      jsonb,                      -- 策略②：预留（匹配需 GitHub API files 只读列表，Batch 3 随 Installation Token）
  label           text,                       -- 策略①：PR Label 精确匹配
  dataset_id      uuid        NOT NULL REFERENCES datasets (id) ON DELETE RESTRICT,
  target_id       uuid        REFERENCES targets (id) ON DELETE RESTRICT,   -- NULL = 不限目标
  enabled         boolean     NOT NULL DEFAULT true,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- 至少给一种匹配策略（否则规则永远不可能命中，属配置脏数据）
  CONSTRAINT ck_pr_trigger_rules_strategy CHECK (
    label IS NOT NULL OR path_globs IS NOT NULL OR target_branch IS NOT NULL
  )
);

CREATE INDEX ix_pr_trigger_rules_repo ON pr_trigger_rules (repo_full_name, enabled);
