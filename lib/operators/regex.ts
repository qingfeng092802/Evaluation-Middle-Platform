/**
 * `regex` 算子。
 *
 * 口径：`RegExp(pattern, caseSensitive ? '' : 'i')` 命中 ⇔ `shouldMatch`。
 * 即：`shouldMatch=true` 时「命中 ⇒ 1，未命中 ⇒ 0」；`shouldMatch=false` 时反过来
 * （禁用词检查：命中即失败）。
 */
import type { OperatorContext, OperatorScore, RegexConfig } from '@eval-platform/contracts';
import { type ConfigurableOperator } from './shared.js';

export const regexOperator: ConfigurableOperator<RegexConfig> = {
  key: 'regex',
  kind: 'rule',
  requiresRetrieval: false,

  async score(ctx: OperatorContext, config: RegexConfig): Promise<OperatorScore> {
    const base = {
      key: 'regex',
      kind: 'rule' as const,
      passed: null,
      threshold: null,
      weight: 1,
    };

    const text = ctx.actualOutput ?? '';
    let re: RegExp;
    try {
      re = new RegExp(config.pattern, config.caseSensitive ? '' : 'i');
    } catch (err) {
      return { ...base, score: 0, reason: `正则非法：${(err as Error).message}` };
    }

    const matched = re.test(text);
    const ok = config.shouldMatch ? matched : !matched;
    const verdict = config.shouldMatch ? '要求命中' : '要求不命中';
    return {
      ...base,
      score: ok ? 1 : 0,
      reason: `${verdict} /${config.pattern}/ ⇒ 实际${matched ? '命中' : '未命中'}`,
    };
  },
};
