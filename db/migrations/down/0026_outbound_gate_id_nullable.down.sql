-- 回滚前提：先清除 gate_id 为 NULL 的行（github 集成级回传留痕），否则约束恢复失败。
DELETE FROM outbound_dispatch_logs WHERE gate_id IS NULL;
ALTER TABLE outbound_dispatch_logs ALTER COLUMN gate_id SET NOT NULL;
