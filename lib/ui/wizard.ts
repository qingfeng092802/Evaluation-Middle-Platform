/**
 * `PG-02` 第 3 步「确定性规则算子」区块的展示口径（纯函数）。
 *
 * 这里**只**放三样东西：六个内置算子的清单、各自参数的默认值、以及把「勾选状态」
 * 编译成 `POST /api/runs` 需要的 `RunEvaluatorInput[]`。
 *
 * ⚠️ 三条阻塞校验**不在这里实现**。
 * 它的唯一实现是 `lib/preflight/index.ts`（服务端 `POST /api/runs` 用的同一份代码）。
 * 前端若要提前提示，就调 `GET /api/runs/preflight`——把规则再抄一遍的后果是
 * 「契约/后端改了、向导没改」，于是前端放行、后端 400，用户看到一句没头没尾的错误。
 *
 * 六个算子的展示名逐字取自 `pages-and-flows.md` PG-07 的清单原文。
 */
import type {
  BuiltinEvaluatorKey,
  EvaluatorConfig,
  RunEvaluatorInput,
} from '@eval-platform/contracts';
import { EvaluatorConfig as EvaluatorConfigSchema } from '@eval-platform/contracts';

/** 向导第 3 步的一个可勾选算子。 */
export interface RuleOperatorSpec {
  readonly key: BuiltinEvaluatorKey;
  readonly label: string;
  /** 一句话说明这个算子看什么，避免用户对着六个名字猜。 */
  readonly hint: string;
  /** 参数区要渲染哪些输入框。 */
  readonly fields: readonly RuleField[];
}

/** 参数输入框的描述。`kind` 决定用哪种受控输入。 */
export type RuleField =
  | { readonly kind: 'int'; readonly name: string; readonly label: string; readonly min: number }
  | {
      readonly kind: 'float';
      readonly name: string;
      readonly label: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: 'text'; readonly name: string; readonly label: string }
  | { readonly kind: 'bool'; readonly name: string; readonly label: string }
  | { readonly kind: 'json'; readonly name: string; readonly label: string };

/**
 * 六个内置规则算子，顺序与 `PG-02` / `PG-07` 的列举顺序一致。
 *
 * **不含 `judge`**：`[FE-03]` 交付物 2 规定 M1 第 3 步只渲染「确定性规则算子」区块。
 * 裁判算子连默认配置都没有（`lib/operators/index.ts` 也未注册），
 * 在这里留一个置灰项只会让人以为差一步就能用。
 */
export const RULE_OPERATOR_SPECS: readonly RuleOperatorSpec[] = [
  {
    key: 'recall_at_k',
    label: 'Recall@K',
    hint: '前 K 条召回覆盖了多少相关文档',
    fields: [
      { kind: 'int', name: 'k', label: 'K 值', min: 1 },
      { kind: 'int', name: 'gradeThreshold', label: '相关性门槛', min: 0 },
    ],
  },
  {
    key: 'mrr',
    label: 'MRR',
    hint: '第一个相关文档的倒数排名',
    fields: [{ kind: 'int', name: 'gradeThreshold', label: '相关性门槛', min: 0 }],
  },
  {
    key: 'ndcg_at_k',
    label: 'nDCG@K',
    hint: '带相关性等级的折损累积增益',
    fields: [{ kind: 'int', name: 'k', label: 'K 值', min: 1 }],
  },
  {
    key: 'json_schema',
    label: 'JSON Schema',
    hint: '输出结构是否符合给定 Schema',
    fields: [
      { kind: 'json', name: 'schema', label: 'JSON Schema' },
      { kind: 'bool', name: 'extractFromText', label: '先从文本中抽取 JSON 代码块' },
    ],
  },
  {
    key: 'regex',
    label: '正则',
    hint: '输出是否命中（或避开）给定正则',
    fields: [
      { kind: 'text', name: 'pattern', label: '正则表达式' },
      { kind: 'bool', name: 'caseSensitive', label: '区分大小写' },
      { kind: 'bool', name: 'shouldMatch', label: '要求命中（关闭则为「必须不命中」）' },
    ],
  },
  {
    key: 'numeric_fidelity',
    label: '数值保真',
    hint: '输出中的数值与参考答案数值在容差内一致',
    fields: [
      { kind: 'float', name: 'tolerance', label: '相对容差', min: 0, max: 1 },
      { kind: 'bool', name: 'missingFails', label: '缺失参考数值即判失败' },
    ],
  },
] as const;

export function operatorSpecOf(key: string): RuleOperatorSpec | undefined {
  return RULE_OPERATOR_SPECS.find((s) => s.key === key);
}

/**
 * 算子的默认参数（勾选时填入的初值）。
 *
 * 与契约的 `.default()` 保持一致：zod 的默认值只在**字段缺省**时生效，
 * 而向导是把配置显式提交上去的，因此必须在这里给出同样的值，
 * 否则「什么都不改直接启动」得到的效果会和契约文档描述的不一样。
 *
 * 用 `switch` 而不是查表：新增第七个内置算子时，这里会因为返回类型不完整
 * 而编译失败——查表则只会静默返回 `undefined`。
 */
export function defaultConfigOf(key: BuiltinEvaluatorKey): EvaluatorConfig {
  switch (key) {
    case 'recall_at_k':
      return { key: 'recall_at_k', k: 5, gradeThreshold: 1 };
    case 'mrr':
      return { key: 'mrr', gradeThreshold: 1 };
    case 'ndcg_at_k':
      return { key: 'ndcg_at_k', k: 5, gainFormula: 'standard' };
    case 'json_schema':
      return { key: 'json_schema', schema: {}, extractFromText: true };
    case 'regex':
      return { key: 'regex', pattern: '', caseSensitive: false, shouldMatch: true };
    case 'numeric_fidelity':
      return { key: 'numeric_fidelity', tolerance: 0.01, missingFails: true };
  }
}

/** 第 3 步里「已勾选」的一个算子 + 它当前的参数。`weight`/`passThreshold` 在向导里可填。 */
export interface SelectedEvaluator {
  readonly key: BuiltinEvaluatorKey;
  readonly config: EvaluatorConfig;
  readonly weight: number;
  /** `null` ⇒ 该算子不参与 `passed` 的 AND 判定，只贡献分数。 */
  readonly passThreshold: number | null;
}

/**
 * 勾选状态 → `POST /api/runs` 的 `evaluators` 数组。
 *
 * 顺序即执行顺序（契约 `RunConfigSnapshot.evaluators` 的注释），
 * 因此这里**保持用户勾选/添加的先后**，不排序——排序会让「先跑哪个」变得不可预期。
 *
 * `passThreshold === null` 时**不带该字段**：契约里它是 `.optional()`，
 * 传 `undefined` 在 `exactOptionalPropertyTypes` 下是类型错误，传 `null` 会被
 * Zod 拒绝（`.min(0)` 不接受 null）。两种都错，所以只能省略。
 */
export function buildEvaluatorInputs(
  selected: readonly SelectedEvaluator[],
): RunEvaluatorInput[] {
  return selected.map((s) => ({
    config: s.config,
    weight: s.weight,
    ...(s.passThreshold === null ? {} : { passThreshold: s.passThreshold }),
  }));
}

/**
 * 已选算子对应的 `evaluatorKeys` 查询串片段（给 `GET /api/runs/preflight` 用）。
 *
 * 空数组时返回 `null` 而不是空串：拼接 `&evaluatorKeys=` 会让服务端把
 * 空串当成一个 key，从而做出「选了但没选到任何算子」的错误判断。
 */
export function evaluatorKeysParam(selected: readonly SelectedEvaluator[]): string | null {
  if (selected.length === 0) return null;
  return selected.map((s) => s.key).join(',');
}

/**
 * 单个算子的参数是否已填好（提交前自检）。
 *
 * 为什么需要：默认参数**并非**天然合法。`RegexConfig.pattern` 契约要求 `min(1)`，
 * 而默认值只能是空串（没有「合理的默认正则」这种东西）。若不在前端拦，
 * 用户勾了「正则」就直接点启动，得到的是一个 400 与一句看不懂的 Zod 报错。
 *
 * 返回第一处错误的中文说明，或 `null` 表示可提交。
 * 判据直接跑 `EvaluatorConfig`，不手写「pattern 不能为空」这类重复规则。
 */
export function operatorConfigError(selected: SelectedEvaluator): string | null {
  const parsed = EvaluatorConfigSchema.safeParse(selected.config);
  if (parsed.success) return null;

  const spec = operatorSpecOf(selected.key);
  const label = spec?.label ?? selected.key;
  const first = parsed.error.issues[0];
  // `path` 指向具体参数名；翻成中文标签比露出 `pattern` 更可读。
  const fieldName = String(first?.path[first.path.length - 1] ?? '');
  const field = spec?.fields.find((f) => f.name === fieldName);
  const where = field === undefined ? '' : `「${field.label}」`;
  return `${label}${where}的参数未填好`;
}
