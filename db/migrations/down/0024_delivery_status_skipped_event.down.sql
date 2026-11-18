ALTER TABLE webhook_deliveries DROP CONSTRAINT ck_webhook_deliveries_status;
ALTER TABLE webhook_deliveries ADD CONSTRAINT ck_webhook_deliveries_status CHECK (processed_status IN
  ('TRIGGERED','SKIPPED_CLOSED','SKIPPED_UNBOUND','DEDUPED','REJECTED_SIGNATURE'));
