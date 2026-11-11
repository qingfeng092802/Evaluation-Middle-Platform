/**
 * `numeric_fidelity` 算子。
 *
 * 口径（SPEC-M1 `[BE-02]`）：
 *   从 `outputText` 按出现顺序正则抽全部数值 `N`；
 *   对 `reference.reference_facts` 每个条目：
 *     数字值按 |x − v| / max(|v|, 1e-12) ≤ tolerance 在 `N` 中找匹配，
 *     非数字按精确子串包含；
 *   score = 命中数 / fact 总数。
 *
 * 边界：无任何 fact 时由 `missingFails` 决定：true ⇒ 0；false ⇒ 1。
 * `reason` 必须写明走了哪一支 —— 前端靠这句话解释「为什么这行是 0 分」。
 *
 * **`passed` 不在这里判**：阈值属于运行实例（`run_evaluators.pass_threshold`），
 * 由 runner 回填。算子一律返回 `passed: null, threshold: null`。
 */
import type {
  NumericFidelityConfig,
  OperatorContext,
  OperatorScore,
} from '@eval-platform/contracts';
import { type ConfigurableOperator } from './shared.js';

/** 从文本里按出现顺序抽出全部数值（支持负号与小数点，不匹配指数写法）。 */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map(Number).filter((n) => Number.isFinite(n));
}

/** 相对误差判定：|x − v| / max(|v|, 1e-12) ≤ tolerance。 */
export function withinTolerance(x: number, v: number, tolerance: number): boolean {
  return Math.abs(x - v) / Math.max(Math.abs(v), 1e-12) <= tolerance;
}

export const numericFidelityOperator: ConfigurableOperator<NumericFidelityConfig> = {
  key: 'numeric_fidelity',
  kind: 'rule',
  requiresRetrieval: false,

  async score(ctx: OperatorContext, config: NumericFidelityConfig): Promise<OperatorScore> {
    const base = {
      key: 'numeric_fidelity',
      kind: 'rule' as const,
      passed: null,
      threshold: null,
      weight: 1,
    };

    const facts = ctx.reference?.reference_facts ?? {};
    const entries = Object.entries(facts);

    if (entries.length === 0) {
      // 必须写明走的是哪一支：这是「无 fact」的两种相反语义
      return config.missingFails
        ? {
            ...base,
            score: 0,
            reason: '参考答案无 reference_facts，且 missingFails=true ⇒ 记 0',
          }
        : {
            ...base,
            score: 1,
            reason: '参考答案无 reference_facts，且 missingFails=false ⇒ 记 1',
          };
    }

    const outputText = ctx.actualOutput ?? '';
    const numbers = extractNumbers(outputText);

    let hit = 0;
    const missed: string[] = [];
    for (const [key, value] of entries) {
      const ok =
        typeof value === 'number'
          ? numbers.some((n) => withinTolerance(n, value, config.tolerance))
          : outputText.includes(value);
      if (ok) hit += 1;
      else missed.push(key);
    }

    return {
      ...base,
      score: hit / entries.length,
      reason:
        missed.length === 0
          ? `${entries.length} 个 fact 全部保真（tolerance=${config.tolerance}）`
          : `命中 ${hit}/${entries.length}，缺失：${missed.join('、')}`,
    };
  },
};
