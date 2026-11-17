-- 0020 · callback_tokens — CI 回调 Token（M4 Batch 3，US-018 拉取鉴权）
-- 事实源：docs/Spec/SPEC-M4.md §2 Batch 3（Q1=C 拉取模式裁定）
-- 不可变：否 —— token 可被替换（重置语义=新增一行并使旧行失效）
-- 安全：**仅存 SHA-256 哈希**，明文只在生成响应中出现一次（CallbackTokenResponse）

CREATE TABLE callback_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id     uuid        NOT NULL REFERENCES regression_gates (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL,   -- SHA-256 hex；明文不落库
  expires_at  timestamptz,            -- NULL = 不过期
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_callback_tokens_hash UNIQUE (token_hash)
);

CREATE INDEX ix_callback_tokens_gate ON callback_tokens (gate_id);

-- 不可变：token 行写入后不 Update/Delete（重置 = 新增行 + 旧行由查询侧按
-- created_at 排序取最新；MVP 不做显式 revoke，避免新增状态机）
CREATE FUNCTION reject_callback_token_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'callback_tokens % is immutable (revoke = register a new token)', OLD.id;
END;
$$;

CREATE TRIGGER trg_callback_tokens_immutable
  BEFORE UPDATE OR DELETE ON callback_tokens
  FOR EACH ROW EXECUTE FUNCTION reject_callback_token_mutation();
