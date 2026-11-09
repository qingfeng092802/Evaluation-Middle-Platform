/**
 * 成本层唯一出口（TS-2 红线 / `OPEN-3`）。
 *
 * 规则：**成本只能由 `model_prices` 单价 × token 算出**，
 * 绝不采信网关（含 LiteLLM）返回的任何成本数字。
 *
 * 这一条在代码里的体现就是：本文件是唯一 import `computeCost` 的地方，
 * worker 拿到的「单价」只能是建 run 时写进 `config_snapshot.priceSnapshot` 的那份，
 * 不允许再去查 `model_prices`（R-11：执行期只读快照）。
 */
import { computeCost } from '@eval-platform/contracts';
import type { ModelPrice } from '@eval-platform/contracts';

export interface PriceSnapshotEntry {
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly inputPricePer1k: number;
  readonly outputPricePer1k: number;
  readonly currency: 'CNY' | 'USD';
  readonly effectiveFrom: string;
}

/** 把生效单价转成快照条目（建 run 时调用一次）。 */
export function toSnapshotEntry(p: ModelPrice): PriceSnapshotEntry {
  return {
    modelProviderId: p.modelProviderId,
    modelId: p.modelId,
    inputPricePer1k: p.inputPricePer1k,
    outputPricePer1k: p.outputPricePer1k,
    currency: p.currency,
    effectiveFrom: p.effectiveFrom,
  };
}

/** 从快照里找某 (provider, model) 的单价；找不到返回 `null`（成本不可计算）。 */
export function findSnapshotPrice(
  snapshot: readonly PriceSnapshotEntry[],
  providerId: string,
  modelId: string,
): PriceSnapshotEntry | null {
  return snapshot.find((p) => p.modelProviderId === providerId && p.modelId === modelId) ?? null;
}

/**
 * 计算单条 Case 的成本（目标侧）。
 *
 * 无单价 ⇒ 返回 `0` 并**不**抛错：fixture 场景单价就是 0，
 * 抛错会让整条链路因为「没配价」而失败，这不是 M1 想要的。
 * 但调用方拿到 0 时必须能解释——`reason` 的职责在算子层，不在这里。
 */
export function computeTargetCost(
  price: PriceSnapshotEntry | null,
  tokensIn: number,
  tokensOut: number,
): number {
  if (!price) return 0;
  return computeCost({
    inputPricePer1k: price.inputPricePer1k,
    outputPricePer1k: price.outputPricePer1k,
    tokensIn,
    tokensOut,
  });
}
