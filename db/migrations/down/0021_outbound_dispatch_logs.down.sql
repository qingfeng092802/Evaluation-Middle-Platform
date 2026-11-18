DROP TRIGGER IF EXISTS trg_outbound_dispatch_logs_immutable ON outbound_dispatch_logs;
DROP FUNCTION IF EXISTS reject_outbound_dispatch_log_mutation();
DROP INDEX IF EXISTS ix_outbound_dispatch_logs_gate;
DROP TABLE IF EXISTS outbound_dispatch_logs;
