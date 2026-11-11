/**
 * 算子工厂：`key → 实现`。
 *
 * 只有**六个内置规则算子**。`judge`（裁判）在 M2 才落地，此处刻意不注册 ——
 * 注册一个空壳会让 `RunPreflight` 误以为裁判可用。
 *
 * 这一层不 import `db`：算子必须是纯函数，否则六个算子会各自长出并发、重试、超时
 * （`TS-3` 短板 2）。
 */
import type { EvaluatorConfig, EvaluatorOperator } from '@eval-platform/contracts';
import type { ConfigurableOperator } from './shared.js';
import { bindOperator } from './shared.js';
import { recallAtKOperator } from './recall-at-k.js';
import { mrrOperator } from './mrr.js';
import { ndcgAtKOperator } from './ndcg-at-k.js';
import { jsonSchemaOperator } from './json-schema.js';
import { regexOperator } from './regex.js';
import { numericFidelityOperator } from './numeric-fidelity.js';

/** 全部带参算子（未绑定具体 config）。 */
export const ALL_OPERATORS = [
  recallAtKOperator,
  mrrOperator,
  ndcgAtKOperator,
  jsonSchemaOperator,
  regexOperator,
  numericFidelityOperator,
] as const;

/** 按 key 取算子；未知 key 返回 `undefined`（调用方决定是 SKIPPED 还是报错）。 */
export function getOperator(key: string) {
  return ALL_OPERATORS.find((op) => op.key === key);
}

/**
 * 按 key 取算子并绑定 run 快照里的 config，得到契约形态的 `EvaluatorOperator`。
 *
 * 这里必须做一次**受控类型擦除**：`ALL_OPERATORS` 是六个不同 config 类型的联合，
 * 而 config 的实际形状由 `run_evaluators.config`（快照）决定、与 key 天然对齐，
 * TypeScript 无法从 `key: string` 推出具体那一个。擦成统一的 `EvaluatorConfig` 后
 * 由算子自己按 key 里的判别字段取值——这也是为什么每个 config 都带 `key` 字段。
 *
 * 未知 key（含 `judge`）返回 `undefined`：M1 不注册裁判，不能让空壳混进 preflight。
 */
export function bindByKey(
  key: string,
  config: EvaluatorConfig,
): EvaluatorOperator | undefined {
  const op = getOperator(key);
  if (!op) return undefined;
  return bindOperator(op as ConfigurableOperator<EvaluatorConfig>, config);
}

/**
 * 供测试与 UI 列举全部算子。
 *
 * 返回的是**未绑定 config** 的算子，因此不能标成契约的 `EvaluatorOperator`
 * （后者的 `score(ctx)` 只有一个入参）。要拿去执行请用 `bindByKey()`。
 */
export function listOperators(): readonly ConfigurableOperator<unknown>[] {
  return ALL_OPERATORS as readonly ConfigurableOperator<unknown>[];
}

export { bindOperator };
export type { ConfigurableOperator };
export type { EvaluatorOperator };
