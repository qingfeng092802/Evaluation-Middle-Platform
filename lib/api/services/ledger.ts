/**
 * 成本台账服务（M4 Batch 4，`US-019` 四维 + fixture 排除，PG-10 数据面）。
 *
 * 分页**少做**（Q3 既有惯例，同 compare/gates）：分组行数量天然有限
 * （模型数 / 评测集数 / 天数 / 发起人数），全量返回，`nextCursor=null`。
 */
import type { CostLedgerDimension, CostLedgerRow } from '@eval-platform/contracts';
import { aggregateLedger, type LedgerRowAgg } from '../../../db/repo/ledger.js';
import { FIXTURE_PROVIDER } from '../../../db/seed/fixture-provider.js';

function toRow(a: LedgerRowAgg): CostLedgerRow {
  return {
    dimensionKey: a.dimensionKey,
    label: a.label,
    tokensIn: Number(a.tokensIn),
    tokensOut: Number(a.tokensOut),
    costTarget: Number(a.costTarget),
    costJudge: Number(a.costJudge),
    costTotal: Number(a.costTotal),
    runCount: a.runCount,
    unknownCostCases: a.unknownCostCases,
  };
}

export async function getLedger(input: {
  from: string;
  to: string;
  dimension: CostLedgerDimension;
}): Promise<{ summary: CostLedgerRow; items: CostLedgerRow[]; page: { nextCursor: null; total: number } }> {
  const { summary, rows } = await aggregateLedger({
    from: input.from,
    to: input.to,
    dimension: input.dimension,
    fixtureProviderName: FIXTURE_PROVIDER.name,
  });
  return {
    summary: toRow(summary),
    items: rows.map(toRow),
    page: { nextCursor: null, total: rows.length },
  };
}
