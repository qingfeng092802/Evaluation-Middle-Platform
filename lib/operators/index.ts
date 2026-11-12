/**
 * 算子工厂：`key → 实现`。
 *
 * 这里只注册**六个内置规则算子**。`judge`（裁判）**刻意不在这里**：
 * 它需要一次模型调用（`lib/operators/judge.ts` 的 `createJudgeOperator({ chat })`），
 * 而这一层的铁律是「不 import `db`、不发网络请求」。把它注册进来，
 * 要么得在这一层塞一个依赖注入容器，要么得让 `bindByKey` 返回一个没有 chat 的空壳 ——
 * 后者会让 `RunPreflight` 以为裁判可用，然后每条 Case 静默失败。
 *
 * 裁判由 runner 侧按 `kind === 'judge'` 单独接线（`lib/runner/execute-case.ts`），
 * 因此 `bindByKey('judge', …)` 返回 `undefined` 是**设计如此**，不是遗漏。
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
 * 未知 key（含 `judge`）返回 `undefined`：裁判的模型调用必须由 runner 注入，
 * 不能在这里造一个没有 chat 的空壳混进执行链（见文件头）。
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
