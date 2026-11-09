/**
 * `mrr` 算子（Mean Reciprocal Rank，单条即为 Reciprocal Rank）。
 *
 * 口径：召回列表第一个 `grade >= gradeThreshold` 的位置 `i`（1-based）→ `1/i`；无命中 → `0`。
 */
import type { MrrConfig, OperatorContext, OperatorScore } from '@eval-platform/contracts';
import { recalledDocIds, relevanceMap, safeScore, type ConfigurableOperator } from './shared.js';

export const mrrOperator: ConfigurableOperator<MrrConfig> = {
  key: 'mrr',
  kind: 'rule',
  requiresRetrieval: true,

  async score(ctx: OperatorContext, config: MrrConfig): Promise<OperatorScore> {
    const relevance = relevanceMap(ctx);
    const recalled = recalledDocIds(ctx);

    for (let i = 0; i < recalled.length; i++) {
      const docId = recalled[i];
      if (docId === undefined) continue;
      const grade = relevance.get(docId);
      if (grade !== undefined && grade >= config.gradeThreshold) {
        return {
          key: 'mrr',
          kind: 'rule',
          score: safeScore(1 / (i + 1)),
          passed: null,
          threshold: null,
          weight: 1,
          reason: `首个相关文档位于第 ${i + 1} 位 ⇒ 1/${i + 1}`,
        };
      }
    }

    return {
      key: 'mrr',
      kind: 'rule',
      score: 0,
      passed: null,
      threshold: null,
      weight: 1,
      reason: recalled.length === 0 ? '召回为空' : '召回列表中无 grade 达标的相关文档',
    };
  },
};
