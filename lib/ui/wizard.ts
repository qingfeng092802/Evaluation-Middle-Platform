/**
 * `PG-02` 第 3 步两个区块的展示口径（纯函数）。
 *
 * 一、六个「确定性规则算子」：清单、默认参数、勾选状态 → `RunEvaluatorInput[]`。
 * 二、「LLM 裁判算子」（M2 · Batch 2）：单独一块，因为它要选**另一个模型**、
 *    写评分 Prompt、定量表，形态与规则算子完全不同。混进同一张清单会让
 *    `RULE_OPERATOR_SPECS` 的键类型从 `BuiltinEvaluatorKey` 退化成 `string`，
 *    `defaultConfigOf` 的穷尽 `switch` 随之失效。
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
  JudgeEvaluatorConfig,
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
 * **不含 `judge`**：裁判算子是另一块（`JUDGE_OPERATOR_SPEC`），
 * 本清单的类型是 `BuiltinEvaluatorKey` 而非 `string`，塞进 `judge` 会让
 * `defaultConfigOf` 的穷尽 `switch` 失去保护（见下方注释）。
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

// ---------------------------------------------------------------------------
// 二、LLM 裁判算子区块（M2 · Batch 2 · 交付物 3）
// ---------------------------------------------------------------------------

/** 裁判区块的字段描述（比规则算子的 `RuleField` 多一种 `enum`：量表只有三档）。 */
export type JudgeField =
  | { readonly kind: 'provider'; readonly name: 'modelProviderId'; readonly label: string }
  | { readonly kind: 'model'; readonly name: 'modelId'; readonly label: string }
  | { readonly kind: 'prompt'; readonly name: 'promptTemplate'; readonly label: string }
  | {
      readonly kind: 'enum';
      readonly name: 'scaleMax';
      readonly label: string;
      readonly options: readonly (1 | 5 | 10)[];
    }
  | {
      readonly kind: 'float';
      readonly name: 'passThreshold';
      readonly label: string;
      /** 界面上填的是**量表内的分**，此处给它的范围。 */
      readonly onScale: true;
    }
  | { readonly kind: 'float'; readonly name: 'temperature'; readonly label: string }
  | { readonly kind: 'int'; readonly name: 'maxTokens'; readonly label: string };

export interface JudgeOperatorSpec {
  readonly key: 'judge';
  readonly label: string;
  readonly hint: string;
  readonly fields: readonly JudgeField[];
}

/**
 * 裁判区块。
 *
 * 字段顺序即用户在界面上从上往下的填写顺序：先「用哪个模型评」，
 * 再「怎么评」（Prompt），最后「量表与阈值」。
 */
export const JUDGE_OPERATOR_SPEC: JudgeOperatorSpec = {
  key: 'judge',
  label: 'LLM 裁判算子',
  hint: '由一个模型按评分 Prompt 给目标输出打分（成本单独入账）',
  fields: [
    { kind: 'provider', name: 'modelProviderId', label: '裁判模型厂商' },
    { kind: 'model', name: 'modelId', label: '裁判模型' },
    { kind: 'prompt', name: 'promptTemplate', label: '评分 Prompt' },
    { kind: 'enum', name: 'scaleMax', label: '量表上界', options: [1, 5, 10] },
    { kind: 'float', name: 'passThreshold', label: '通过阈值（量表内分）', onScale: true },
    { kind: 'float', name: 'temperature', label: '温度' },
    { kind: 'int', name: 'maxTokens', label: '最大输出 token' },
  ],
};

/**
 * 裁判区块的表单草稿。
 *
 * **注意 `passScoreOnScale` 与 `passThreshold` 是两个不同的量**：
 *  - `passScoreOnScale`：用户在界面上填的分（如「5 分制里够 3 分算过」），
 *  - `passThreshold`：契约里**归一化到 [0,1]** 的那个值（0.6）。
 *
 * 之所以不让 UI 直接编辑 `passThreshold`：用户在 10 分制下会想填 6，
 * 而契约的 `.max(1)` 会直接拒掉 6。把换算藏进 `buildJudgeConfig()` 里，
 * 界面上就只需要「量表内分」这一种心智。
 */
export interface JudgeDraft {
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly promptTemplate: string;
  readonly scaleMax: 1 | 5 | 10;
  readonly passScoreOnScale: number;
  readonly temperature: number;
  readonly maxTokens: number | undefined;
}

/** 草稿的默认值：5 分制、够 3 分算过（= 0.6，与契约默认一致）。 */
export function defaultJudgeDraft(providerId: string): JudgeDraft {
  return {
    modelProviderId: providerId,
    modelId: '',
    promptTemplate:
      '请给下面这条回答打分。\n\n题目：{{input}}\n模型输出：{{output}}\n参考答案：{{reference}}\n\n请按 5 分制打分，并只输出 JSON：{"score": <0-5 的整数>, "reason": "<一句话理由>"}',
    scaleMax: 5,
    passScoreOnScale: 3,
    temperature: 0,
    maxTokens: undefined,
  };
}

/**
 * 量表内分 → 归一化阈值。
 *
 * `scaleMax` 是量表上界，`score` 在契约里恒为归一化值，因此阈值也必须归一化。
 * 这里**不 clamp** 到 [0,1] 以外也照样算——越界由 `buildJudgeConfig` 兜住
 * （它会让契约自己拒），静默 clamp 会把「用户填错了」变成「阈值悄悄变成 1」。
 */
export function judgeScaleThresholdToNormalized(scoreOnScale: number, scaleMax: number): number {
  return scoreOnScale / scaleMax;
}

/** 归一化阈值 → 量表内分（用于把已存的配置回显到界面上）。 */
export function judgeThresholdToScale(normalized: number, scaleMax: number): number {
  return normalized * scaleMax;
}

/**
 * 草稿 → `JudgeEvaluatorConfig`。
 *
 * **把量表分换算成归一化阈值**（见 `JudgeDraft` 的注释）。越界的量表分会被
 * `Math.min/max` 夹到合法区间，而不是原样吐出：这个函数可能被 UI 的漏拦路径调到，
 * 那时产出契约非法值只会在服务端变成一个看不懂的 400。
 */
export function buildJudgeConfig(draft: JudgeDraft): JudgeEvaluatorConfig {
  const normalized = judgeScaleThresholdToNormalized(draft.passScoreOnScale, draft.scaleMax);
  const passThreshold = Math.min(1, Math.max(0, Number.isFinite(normalized) ? normalized : 0));

  return {
    key: 'judge',
    modelProviderId: draft.modelProviderId,
    modelId: draft.modelId,
    promptTemplate: draft.promptTemplate,
    scaleMax: draft.scaleMax,
    passThreshold,
    temperature: draft.temperature,
    ...(draft.maxTokens === undefined ? {} : { maxTokens: draft.maxTokens }),
  };
}

/**
 * 提交前的**警告**（不是错误：都能提交，只是结果可能没意义）。
 *
 * 三条：
 *  1. Prompt 没有 `{{output}}` ⇒ 裁判看不到被评的东西，只能瞎猜；
 *  2. Prompt 没有 `{{reference}}` ⇒ 没参考答案，裁判只能凭自己的知识判断；
 *  3. 裁判模型 == 目标模型 ⇒ 自己评自己。允许（可做一致性检查），但要提醒。
 *
 * 只返回**中文句子**，UI 直接渲染。
 */
export function judgeWarnings(
  draft: JudgeDraft,
  target?: { readonly targetProviderId: string; readonly targetModelId: string },
): string[] {
  const out: string[] = [];
  if (!draft.promptTemplate.includes('{{output}}')) {
    out.push('评分 Prompt 未引用 {{output}}，裁判将看不到被评的输出');
  }
  if (!draft.promptTemplate.includes('{{reference}}')) {
    out.push('评分 Prompt 未引用 {{reference}}，无参考答案时裁判只能凭自身知识判断');
  }
  if (
    target !== undefined &&
    draft.modelId !== '' &&
    draft.modelId === target.targetModelId &&
    draft.modelProviderId === target.targetProviderId
  ) {
    out.push('裁判模型与目标模型是同一个模型，等于自己评自己，分数仅供参考');
  }
  return out;
}

/**
 * 提交前的**错误**（不修就提交不上去）。
 *
 * 与 `judgeWarnings` 分开：警告是「能跑但没意义」，错误是「跑了必然 400」。
 * 把两者混成一个列表，UI 就只能用一种颜色渲染，用户分不清哪个非改不可。
 *
 * 判据不手写「modelId 不能为空」这类重复规则，而是跑契约的 `EvaluatorConfig`，
 * 与 `operatorConfigError()` 同一口径。
 */
export function judgeConfigError(draft: JudgeDraft): string | null {
  const parsed = EvaluatorConfigSchema.safeParse(buildJudgeConfig(draft));
  if (parsed.success) return null;

  const first = parsed.error.issues[0];
  const path = String(first?.path[first.path.length - 1] ?? '');

  // 把契约里的字段名翻成界面上的标签，比露出 `promptTemplate` 可读
  const labelOf: Readonly<Record<string, string>> = {
    modelProviderId: '裁判模型厂商',
    modelId: '裁判模型',
    promptTemplate: '评分 Prompt',
    scaleMax: '量表上界',
    passThreshold: '通过阈值',
    temperature: '温度',
    maxTokens: '最大输出 token',
  };
  const label = labelOf[path] ?? '参数';
  return `裁判算子的「${label}」未填好`;
}

/**
 * 把「规则算子勾选状态 + 裁判草稿」编译成 `POST /api/runs` 的 `evaluators` 数组。
 *
 * ## 为什么需要这么一个合并函数
 *
 * 两类算子在界面上是两块独立的 UI，但服务端只看到一个 `evaluators` 数组，
 * 且**数组顺序即执行顺序**。若两个区块各自往同一个 state 里塞，
 * 顺序就会退化成「谁先渲染谁在前」，而渲染顺序与用户选择顺序无关。
 *
 * `order` 是**算子 key 的完整顺序**（如 `['judge', 'regex']`），
 * 缺省时「规则在前、裁判在后」—— 这是更符合直觉的次序（先确定性判定，再语义裁判）。
 *
 * 只按 `order` 里出现过的条目产出；`order` 里没有的条目**补在后面**，
 * 而不是静默丢弃：漏一个算子等于少一项评分，且用户从界面上看不出来。
 */
export function buildRunEvaluators(input: {
  judge: JudgeDraft | null;
  rules?: readonly SelectedEvaluator[];
  /** 算子 key 的先后；缺省 = 全部规则算子（按勾选顺序）+ 裁判。 */
  order?: readonly string[];
}): RunEvaluatorInput[] {
  const rules = input.rules ?? [];

  const byKey = new Map<string, RunEvaluatorInput>();
  for (const r of buildEvaluatorInputs(rules)) {
    byKey.set(r.config.key, r);
  }
  if (input.judge !== null) {
    const cfg = buildJudgeConfig(input.judge);
    byKey.set('judge', { config: cfg, weight: 1, passThreshold: cfg.passThreshold });
  }

  const order =
    input.order ?? (input.judge === null ? rules.map((r) => r.key) : [...rules.map((r) => r.key), 'judge']);

  const out: RunEvaluatorInput[] = [];
  const emitted = new Set<string>();
  for (const key of order) {
    const entry = byKey.get(key);
    if (entry !== undefined && !emitted.has(key)) {
      out.push(entry);
      emitted.add(key);
    }
  }
  // 防御：`order` 漏掉的条目补在末尾，不静默丢弃
  for (const [key, entry] of byKey) {
    if (!emitted.has(key)) out.push(entry);
  }
  return out;
}
