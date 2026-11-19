-- 0025 · outbound_dispatch_logs 通道枚举增补 'github'（M5 Batch 3，Q5 回传留痕）
-- 事实源：docs/Spec/SPEC-M5.md §2.4 / §附录 A；GateChannel 枚举不动（Q2）——
--       'github' 只出现在**出站留痕**的通道口径里（回传是集成级，不是规则级渠道）。

ALTER TABLE outbound_dispatch_logs DROP CONSTRAINT ck_outbound_dispatch_logs_kind;
ALTER TABLE outbound_dispatch_logs ADD CONSTRAINT ck_outbound_dispatch_logs_kind CHECK (channel_kind IN
  ('feishu', 'wecom', 'webhook', 'github'));
