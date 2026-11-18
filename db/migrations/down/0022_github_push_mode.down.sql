DROP TABLE IF EXISTS pr_trigger_rules;
DROP TRIGGER IF EXISTS trg_webhook_deliveries_immutable ON webhook_deliveries;
DROP FUNCTION IF EXISTS reject_webhook_delivery_mutation();
DROP INDEX IF EXISTS ix_webhook_deliveries_integration;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS github_integrations;
