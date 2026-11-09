/**
 * 仓储 · `model_prices`。
 *
 * **单价是成本的唯一事实源**（TS-2 红线）：任何成本都只能由本表单价 × token 算出，
 * 绝不采信网关（含 LiteLLM）返回的成本数字。
 *
 * 生效单价口径：同一 `(provider, model)` 取 `effective_from <= now()` 中
 * **`effective_from` 最大**的一行。所以这里只提供 `getEffectivePrice`，
 * 不提供「取全部历史」—— 建 run 时快照的就是这一行。
 */
import type { ModelPrice } from '@eval-platform/contracts';
import { iso, num, query, queryOne } from './_client.js';

interface PriceRow {
  id: string;
  model_provider_id: string;
  model_id: string;
  display_name: string;
  input_price_per_1k: string;
  output_price_per_1k: string;
  currency: string;
  effective_from: Date;
  created_at: Date;
}

function toPrice(r: PriceRow): ModelPrice {
  return {
    id: r.id,
    modelProviderId: r.model_provider_id,
    modelId: r.model_id,
    displayName: r.display_name,
    inputPricePer1k: num(r.input_price_per_1k),
    outputPricePer1k: num(r.output_price_per_1k),
    currency: r.currency as ModelPrice['currency'],
    effectiveFrom: iso(r.effective_from),
    createdAt: iso(r.created_at),
  };
}

/** 某厂商某模型在 `now()` 生效的单价；无记录返回 `null`（= 成本不可计算，必须报错而不是记 0）。 */
export async function getEffectivePrice(
  providerId: string,
  modelId: string,
): Promise<ModelPrice | null> {
  const row = await queryOne<PriceRow>(
    `SELECT id, model_provider_id, model_id, display_name,
            input_price_per_1k, output_price_per_1k, currency, effective_from, created_at
       FROM model_prices
      WHERE model_provider_id = $1 AND model_id = $2 AND effective_from <= now()
      ORDER BY effective_from DESC
      LIMIT 1`,
    [providerId, modelId],
  );
  return row ? toPrice(row) : null;
}

/** 全部单价行（列表/调试用）。 */
export async function listPrices(): Promise<ModelPrice[]> {
  const rows = await query<PriceRow>(
    `SELECT id, model_provider_id, model_id, display_name,
            input_price_per_1k, output_price_per_1k, currency, effective_from, created_at
       FROM model_prices ORDER BY effective_from DESC`,
  );
  return rows.map(toPrice);
}

/**
 * 种子用：幂等写入 fixture 单价。
 *
 * `effective_from` 固定一个**过去**的时刻（而非 `now()`），
 * 这样重复执行种子不会因「唯一键含时间」而插出多行。
 */
export async function upsertFixturePrice(p: {
  providerId: string;
  modelId: string;
  displayName: string;
  inputPricePer1k: number;
  outputPricePer1k: number;
  currency: string;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO model_prices
       (model_provider_id, model_id, display_name, input_price_per_1k, output_price_per_1k, currency, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01T00:00:00Z'::timestamptz)
     ON CONFLICT (model_provider_id, model_id, effective_from) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           input_price_per_1k = EXCLUDED.input_price_per_1k,
           output_price_per_1k = EXCLUDED.output_price_per_1k,
           currency = EXCLUDED.currency
     RETURNING id`,
    [
      p.providerId,
      p.modelId,
      p.displayName,
      String(p.inputPricePer1k),
      String(p.outputPricePer1k),
      p.currency,
    ],
  );
  if (!row) throw new Error('upsertFixturePrice 未返回 id');
  return row.id;
}
