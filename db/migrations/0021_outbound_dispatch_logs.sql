-- 0021 · outbound_dispatch_logs — 出站派发留痕（PG-09 渠道历史 / 失败可追责）
-- 事实源：docs/facts/database-schema.md §2.17；US-018 出站派发（Q1=C 拉取模式裁定）
-- 不可变：是 —— 留痕只追加，UPDATE / DELETE 一律被触发器拒绝（补投递 = 新增一行）
-- 安全：payload 只含门禁摘要与渠道载荷；GateChannel 契约只有 webhook URL，
--       永不出现 token / PAT 字段，本表因此无任何凭据可泄

CREATE TABLE outbound_dispatch_logs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id       uuid        NOT NULL REFERENCES regression_gates (id) ON DELETE CASCADE,
  eval_run_id   uuid        NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  channel_kind  text        NOT NULL,
  channel_url   text        NOT NULL,
  payload       jsonb       NOT NULL,
  status        text        NOT NULL,
  error_message text,
  -- 重试次数（重试机制属后续批次；当前派发单次尝试，恒为 0 —— 只记事实，不编语义）
  retry_count   int         NOT NULL DEFAULT 0,
  dispatched_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_outbound_dispatch_logs_kind CHECK (channel_kind IN ('feishu', 'wecom', 'webhook')),
  CONSTRAINT ck_outbound_dispatch_logs_status CHECK (status IN ('SUCCESS', 'FAILED')),
  -- FAILED 必须带原因；SUCCESS 不允许编造原因
  CONSTRAINT ck_outbound_dispatch_logs_error CHECK (
    (status = 'FAILED' AND error_message IS NOT NULL)
    OR (status = 'SUCCESS' AND error_message IS NULL)
  ),
  CONSTRAINT ck_outbound_dispatch_logs_retry CHECK (retry_count >= 0)
);

CREATE INDEX ix_outbound_dispatch_logs_gate ON outbound_dispatch_logs (gate_id, dispatched_at DESC);

-- 不可变：留痕写入后不 Update / Delete（重试 / 补投递 = 新增一行，历史不可改写）
CREATE FUNCTION reject_outbound_dispatch_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outbound_dispatch_logs % is immutable (re-dispatch = insert a new row)', OLD.id;
END;
$$;

CREATE TRIGGER trg_outbound_dispatch_logs_immutable
  BEFORE UPDATE OR DELETE ON outbound_dispatch_logs
  FOR EACH ROW EXECUTE FUNCTION reject_outbound_dispatch_log_mutation();
