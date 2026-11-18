-- 0024 · webhook_deliveries 状态枚举增补 SKIPPED_EVENT（M5 Batch 2）
-- 事实源：docs/Spec/SPEC-M5.md §2.4；WebhookResponse 契约统一口径
-- 语义：非评测事件（GitHub ping / 未配置的其他事件）签名验真后同样落账（统一审计），
--       处理状态记 SKIPPED_EVENT——不触发评测、不建 run。

ALTER TABLE webhook_deliveries DROP CONSTRAINT ck_webhook_deliveries_status;
ALTER TABLE webhook_deliveries ADD CONSTRAINT ck_webhook_deliveries_status CHECK (processed_status IN
  ('TRIGGERED','SKIPPED_CLOSED','SKIPPED_UNBOUND','DEDUPED','REJECTED_SIGNATURE','SKIPPED_EVENT'));
