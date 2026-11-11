/**
 * `recall_at_k` 算子。
 *
 * 口径（SPEC-M1 `[BE-02]` 算法口径表）：
 *   relevant = { doc_id | grade >= gradeThreshold }
 *   hit      = recalled[0..k) ∩ relevant
 *   score    = |hit| / |relevant|
 *
 * 边界：`|relevant| = 0` ⇒ 返回 `0`（不得 `NaN`）；召回为空 ⇒ `0`。
 */
import type { OperatorContext, OperatorScore, RecallAtKConfig } from '@eval-platform/contracts';
import { recalledDocIds, relevantDocIds, safeScore, type ConfigurableOperator } from './shared.js';

export const recallAtKOperator: ConfigurableOperator<RecallAtKConfig> = {
  key: 'recall_at_k',
  kind: 'rule',
  requiresRetrieval: true,

  async score(ctx: OperatorContext, config: RecallAtKConfig): Promise<OperatorScore> {
    const relevant = relevantDocIds(ctx, config.gradeThreshold);
    const topK = recalledDocIds(ctx).slice(0, config.k);

    if (relevant.size === 0) {
      return {
        key: 'recall_at_k',
        kind: 'rule',
        score: 0,
        passed: null,
        threshold: null,
        weight: 1,
        reason: `标注中 grade ≥ ${config.gradeThreshold} 的文档数为 0，Recall 不可定义，按口径记 0`,
      };
    }

    let hit = 0;
    for (const docId of new Set(topK)) {
      if (relevant.has(docId)) hit += 1;
    }

    return {
      key: 'recall_at_k',
      kind: 'rule',
      score: safeScore(hit / relevant.size),
      passed: null,
      threshold: null,
      weight: 1,
      reason: `top-${config.k} 命中 ${hit} / 相关 ${relevant.size}`,
    };
  },
};
