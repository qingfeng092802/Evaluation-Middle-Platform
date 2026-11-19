ALTER TABLE outbound_dispatch_logs DROP CONSTRAINT ck_outbound_dispatch_logs_kind;
ALTER TABLE outbound_dispatch_logs ADD CONSTRAINT ck_outbound_dispatch_logs_kind CHECK (channel_kind IN
  ('feishu', 'wecom', 'webhook'));
