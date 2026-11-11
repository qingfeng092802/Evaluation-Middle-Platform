/**
 * 算子公共工具。
 *
 * 六个算子共用的三件事：从上下文取召回 doc_id 列表、取检索标注、把 NaN/Infinity 归零。
 * 抽出来是为了让「不产生 NaN」这条口径只实现一次 —— 六个算子各自写一遍必然有漏。
 */
import type {
  EvaluatorKind,
  EvaluatorOperator,
  OperatorContext,
  OperatorScore,
} from '@eval-platform/contracts';

/**
 * 「带参数的算子」类型。
 *
 * 为什么不直接实现契约里的 `EvaluatorOperator`：那个接口的 `score(ctx)` **只有入参
 * ctx**，而规则算子的参数（k / tolerance / pattern…）必须每实例不同。若把参数塞进
 * 闭包，`composeCaseScore` 的快照与调试就看不到参数。
 *
 * 因此本层用两参数签名，再由 `bindOperator()` 把某个具体 config 绑成契约要求的
 * `EvaluatorOperator`。**契约不改**（SPEC-M1 C-1），适配发生在我们这一侧。
 */
export interface ConfigurableOperator<C> {
  readonly key: string;
  readonly kind: EvaluatorKind;
  readonly requiresRetrieval: boolean;
  score(ctx: OperatorContext, config: C): Promise<OperatorScore>;
}

/** 把带参算子 + 具体参数绑定成契约 `EvaluatorOperator`（供 runner 调用）。 */
export function bindOperator<C>(
  operator: ConfigurableOperator<C>,
  config: C,
): EvaluatorOperator {
  return {
    key: operator.key,
    kind: operator.kind,
    requiresRetrieval: operator.requiresRetrieval,
    score: (ctx: OperatorContext) => operator.score(ctx, config),
  };
}


/** 口径：任何算不出有意义数值的情形一律归 `0`，绝不把 `NaN` / `Infinity` 漏给上层。 */
export function safeScore(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * 召回顺序（1-based 位置由下标 + 1 得到）。
 * `retrievedContexts` 为 `null` ⇒ 空数组（视为「什么都没召回」）。
 */
export function recalledDocIds(ctx: OperatorContext): string[] {
  return (ctx.retrievedContexts ?? []).map((c) => c.doc_id);
}

/**
 * 标注中的相关性表：`doc_id → grade`。
 * 同一 doc_id 出现多次时取**最大** grade —— 标注重复不该稀释相关性。
 */
export function relevanceMap(ctx: OperatorContext): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of ctx.retrievalAnnotation?.relevant ?? []) {
    const prev = map.get(item.doc_id);
    map.set(item.doc_id, prev === undefined ? item.grade : Math.max(prev, item.grade));
  }
  return map;
}

/** 按 `gradeThreshold` 过滤出「相关文档」集合。 */
export function relevantDocIds(ctx: OperatorContext, gradeThreshold: number): Set<string> {
  const out = new Set<string>();
  for (const [docId, grade] of relevanceMap(ctx)) {
    if (grade >= gradeThreshold) out.add(docId);
  }
  return out;
}
