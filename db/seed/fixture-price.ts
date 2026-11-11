/**
 * 种子 · fixture 模型单价（`model_prices` 唯一一行）。
 *
 * **单价固定为 0**：本地回显网关不产生成本。这不是「懒得填」，
 * 而是让 AC 里的 `cost_total = 0` 成为可推导的结论（0 × token = 0），
 * 而不是一个被硬编码进断言的魔数。
 *
 * `display_name` 是 `NOT NULL` 且不可省（`0005_model_prices.sql`）。
 * 调价只增行不改行（`MP-2`）：未来接真实厂商时新增一行、提高 `effective_from`，
 * 历史 run 的 `config_snapshot.priceSnapshot` 仍然对得上当时的价。
 */
import { FIXTURE_MODEL_ID } from './fixture-provider.js';

export const FIXTURE_PRICE = {
  modelId: FIXTURE_MODEL_ID,
  displayName: 'Fixture Echo 1（离线自检）',
  inputPricePer1k: 0,
  outputPricePer1k: 0,
  currency: 'CNY' as const,
} as const;
