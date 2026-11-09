/**
 * `ndcg_at_k` 算子。
 *
 * 口径：
 *   DCG  = Σ_{i=1..k} (2^g_i − 1) / log2(i+1)，`g_i` = 第 i 位召回的 grade（不在标注中记 0）
 *   IDCG = 标注 grade 降序截取前 k，同式
 *   score = DCG / IDCG
 *
 * 边界：`IDCG = 0` ⇒ 返回 `0`，**不得返回 `NaN` / `Infinity`**。
 */
import type {
  NdcgAtKConfig,
  OperatorContext,
  OperatorScore,
} from '@eval-platform/contracts';
import { recalledDocIds, relevanceMap, safeScore, type ConfigurableOperator } from './shared.js';

/** 标准增益折损：`(2^g − 1) / log2(rank + 1)`，rank 从 1 起。 */
function dcgOf(grades: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i] ?? 0;
    sum += (2 ** g - 1) / Math.log2(i + 2);
  }
  return sum;
}

export const ndcgAtKOperator: ConfigurableOperator<NdcgAtKConfig> = {
  key: 'ndcg_at_k',
  kind: 'rule',
  requiresRetrieval: true,

  async score(ctx: OperatorContext, config: NdcgAtKConfig): Promise<OperatorScore> {
    const relevance = relevanceMap(ctx);
    const recalled = recalledDocIds(ctx).slice(0, config.k);

    // 实际排序的增益序列（未在标注中出现的召回归 0 增益）
    const actualGrades = recalled.map((docId) => relevance.get(docId) ?? 0);

    // 理想排序：标注 grade 降序取前 k
    const idealGrades = [...relevance.values()].sort((a, b) => b - a).slice(0, config.k);

    const dcg = dcgOf(actualGrades);
    const idcg = dcgOf(idealGrades);

    if (idcg === 0) {
      return {
        key: 'ndcg_at_k',
        kind: 'rule',
        score: 0,
        passed: null,
        threshold: null,
        weight: 1,
        reason: 'IDCG = 0（标注 grade 全为 0 或无标注），nDCG 不可定义，按口径记 0',
      };
    }

    return {
      key: 'ndcg_at_k',
      kind: 'rule',
      score: safeScore(dcg / idcg),
      passed: null,
      threshold: null,
      weight: 1,
      reason: `DCG=${dcg.toFixed(6)} / IDCG=${idcg.toFixed(6)} @k=${config.k}`,
    };
  },
};
