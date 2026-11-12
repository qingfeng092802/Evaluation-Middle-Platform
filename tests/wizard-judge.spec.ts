/**
 * `PG-02` 步骤 3 的「LLM 裁判算子」配置区块（Batch 2 · 交付物 3）。
 *
 * 原文：「`PG-02` 步骤 3 补「LLM 裁判算子」配置区块（`JudgeEvaluatorConfig`：
 * 裁判模型、评分 Prompt、`scaleMax`、`passThreshold`）」。
 *
 * ## 为什么要独立成区块，而不是塞进六个规则算子的清单
 *
 * 两者形态不同：规则算子的参数是「一个 k 值 / 一个正则」，填错只是判错；
 * 裁判算子要选**另一个模型**、写一段**评分 Prompt**、还要定**量表**。
 * 混进同一张清单会让 `RULE_OPERATOR_SPECS` 的类型从
 * `BuiltinEvaluatorKey` 变成 `string`，`defaultConfigOf` 的穷尽 `switch` 也就废了
 * （`tests/wizard-ui.spec.ts` 已有断言盯着「清单里恰好六个、不含 judge」）。
 *
 * ## 这个区块最容易错的两处
 *
 * 1. **`scaleMax` 与 `passThreshold` 的量纲**。契约里 `passThreshold` 是
 *    **归一化到 [0,1]** 的值，而用户在界面上想填的是「10 分制里够 6 分算过」。
 *    直接把 6 塞进 `passThreshold` 会被契约的 `.max(1)` 拒掉；反过来把 0.6 当成
 *    「量表 6 分」显示则会让用户以为阈值是 0.6/10。因此这里显式提供换算。
 * 2. **裁判模型不能等于目标模型却不提示**。自己评自己能跑，但分数没有意义。
 *    这不是硬错误（用户可能就是想做一致性检查），所以只返回**警告**而非错误。
 */
import { describe, expect, it } from 'vitest';
import {
  EvaluatorConfig,
  RunEvaluatorInput,
  type JudgeEvaluatorConfig,
} from '@eval-platform/contracts';
import {
  JUDGE_OPERATOR_SPEC,
  buildJudgeConfig,
  buildRunEvaluators,
  judgeConfigError,
  judgeScaleThresholdToNormalized,
  judgeThresholdToScale,
  judgeWarnings,
  type JudgeDraft,
  type SelectedEvaluator,
} from '../lib/ui/wizard.js';

const PROVIDER = '11111111-1111-1111-1111-111111111111';

const draft = (over: Partial<JudgeDraft> = {}): JudgeDraft => ({
  modelProviderId: PROVIDER,
  modelId: 'judge-model',
  promptTemplate: '题目：{{input}}\n输出：{{output}}\n参考答案：{{reference}}\n请按 5 分制打分。',
  scaleMax: 5,
  /** 界面上填的是**量表内的分**（5 分制里 3 分算过）。 */
  passScoreOnScale: 3,
  temperature: 0,
  maxTokens: undefined,
  ...over,
});

describe('裁判配置区块 · 区块本身的形状', () => {
  it('有一个独立的裁判 spec，含四个必需字段的说明', () => {
    expect(JUDGE_OPERATOR_SPEC.key).toBe('judge');
    expect(JUDGE_OPERATOR_SPEC.label).toContain('裁判');
    const names = JUDGE_OPERATOR_SPEC.fields.map((f) => f.name);
    // 交付物 3 逐字点名的四项
    expect(names).toContain('modelProviderId');
    expect(names).toContain('modelId');
    expect(names).toContain('promptTemplate');
    expect(names).toContain('scaleMax');
    expect(names).toContain('passThreshold');
  });

  it('scaleMax 只给 1 / 5 / 10 三档（契约就是这么约束的）', () => {
    const f = JUDGE_OPERATOR_SPEC.fields.find((x) => x.name === 'scaleMax');
    expect(f?.kind).toBe('enum');
    expect(f?.kind === 'enum' ? [...f.options] : []).toEqual([1, 5, 10]);
  });

  it('默认草稿是合法的 JudgeEvaluatorConfig（勾选即能提交）', () => {
    const defaultDraft = buildJudgeConfig({
      ...draft(),
      modelProviderId: PROVIDER,
      promptTemplate: '题目：{{input}}',
    });
    expect(EvaluatorConfig.safeParse(defaultDraft).success).toBe(true);
  });
});

describe('裁判配置区块 · 量表与阈值的量纲换算', () => {
  it('5 分制、界面上填 3 分 ⇒ 提交 0.6', () => {
    expect(judgeScaleThresholdToNormalized(3, 5)).toBeCloseTo(0.6, 9);
  });

  it('10 分制、界面上填 6 分 ⇒ 提交 0.6', () => {
    expect(judgeScaleThresholdToNormalized(6, 10)).toBeCloseTo(0.6, 9);
  });

  it('1 分制、填 1 ⇒ 提交 1.0', () => {
    expect(judgeScaleThresholdToNormalized(1, 1)).toBe(1);
  });

  it('反向：已存的 0.6 在 10 分制下回显为 6 分', () => {
    expect(judgeThresholdToScale(0.6, 10)).toBeCloseTo(6, 9);
  });

  it('往返一致（10 分制 7 分 → 0.7 → 7 分）', () => {
    const norm = judgeScaleThresholdToNormalized(7, 10);
    expect(judgeThresholdToScale(norm, 10)).toBeCloseTo(7, 9);
  });

  it('buildJudgeConfig 会做换算，而不是把量表分直接塞进 passThreshold', () => {
    const cfg: JudgeEvaluatorConfig = buildJudgeConfig(draft({ scaleMax: 10, passScoreOnScale: 6 }));
    expect(cfg.passThreshold, '直接把 6 塞进去会被契约的 max(1) 拒掉').toBeCloseTo(0.6, 9);
    expect(EvaluatorConfig.safeParse(cfg).success).toBe(true);
  });

  it('量表分超上界时 build 仍给出契约合法值（由 UI 侧的校验先拦）', () => {
    // 防守：即便 UI 漏拦，也不能产出契约非法的 config。
    const cfg = buildJudgeConfig(draft({ scaleMax: 5, passScoreOnScale: 9 }));
    expect(EvaluatorConfig.safeParse(cfg).success).toBe(true);
  });
});

describe('裁判配置区块 · 提交前自检', () => {
  it('Prompt 没引用 {{output}} ⇒ 给警告（裁判没看到被评的东西）', () => {
    const w = judgeWarnings(draft({ promptTemplate: '题目：{{input}}' }));
    expect(w.some((x) => x.includes('output'))).toBe(true);
  });

  it('Prompt 没引用 {{reference}} ⇒ 给警告（无参考答案时裁判只能凭感觉）', () => {
    const w = judgeWarnings(draft({ promptTemplate: '题目：{{input}}\n输出：{{output}}' }));
    expect(w.some((x) => x.includes('reference'))).toBe(true);
  });

  it('Prompt 三个占位符都齐 ⇒ 无警告', () => {
    expect(judgeWarnings(draft())).toEqual([]);
  });

  it('裁判模型与目标模型相同 ⇒ 给出「自己评自己」警告（不阻断）', () => {
    const w = judgeWarnings(draft({ modelId: 'target-model' }), {
      targetProviderId: PROVIDER,
      targetModelId: 'target-model',
    });
    expect(w.some((x) => x.includes('同一个模型'))).toBe(true);
  });

  it('裁判模型与目标模型不同 ⇒ 无该警告', () => {
    const w = judgeWarnings(draft({ modelId: 'other' }), {
      targetProviderId: PROVIDER,
      targetModelId: 'target-model',
    });
    expect(w.every((x) => !x.includes('同一个模型'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 与规则算子**共存**：两类算子都要进同一份 evaluators 数组
// ---------------------------------------------------------------------------

describe('裁判与规则算子共存于同一次运行', () => {
  const rule: SelectedEvaluator = {
    key: 'regex',
    config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true },
    weight: 1,
    passThreshold: 0.5,
  };

  it('两类算子按用户选择顺序进入 evaluators（顺序即执行顺序）', () => {
    const out = buildRunEvaluators({
      judge: draft(),
      rules: [rule],
      order: ['judge', 'regex'],
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.config.key).toBe('judge');
    expect(out[1]?.config.key).toBe('regex');
  });

  it('judge 条目的 passThreshold 是归一化值（不是量表分）', () => {
    const out = buildRunEvaluators({ judge: draft({ scaleMax: 10, passScoreOnScale: 6 }) });
    const j = out.find((e) => e.config.key === 'judge');
    expect(j?.passThreshold).toBeCloseTo(0.6, 9);
  });

  it('没有裁判时只出规则条目', () => {
    const out = buildRunEvaluators({ judge: null, rules: [rule] });
    expect(out.map((e) => e.config.key)).toEqual(['regex']);
  });

  it('只有裁判时也能提交（evaluators 至少一个）', () => {
    const out = buildRunEvaluators({ judge: draft() });
    expect(out.map((e) => e.config.key)).toEqual(['judge']);
  });

  it('每个产物都能被 RunEvaluatorInput 契约接受', () => {
    for (const e of buildRunEvaluators({ judge: draft(), rules: [rule] })) {
      expect(RunEvaluatorInput.safeParse(e).success, JSON.stringify(e)).toBe(true);
    }
  });

  it('judge 也计入 evaluatorKeys 查询串（preflight 需要知道选了它）', () => {
    const out = buildRunEvaluators({ judge: draft(), rules: [rule], order: ['judge', 'regex'] });
    // 与页面用的是同一条路径：直接取最终提交数组里的 key
    expect(out.map((e) => e.config.key)).toEqual(['judge', 'regex']);
  });
});

describe('裁判配置区块 · 提交前自检（错误，非警告）', () => {
  it('裁判模型为空 ⇒ 返回错误（否则提交后被契约拒）', () => {
    expect(judgeConfigError(draft({ modelId: '' }))).toContain('裁判模型');
  });

  it('Prompt 为空 ⇒ 返回错误', () => {
    expect(judgeConfigError(draft({ promptTemplate: '' }))).toContain('Prompt');
  });

  it('配置齐全 ⇒ 返回 null', () => {
    expect(judgeConfigError(draft())).toBeNull();
  });
});
