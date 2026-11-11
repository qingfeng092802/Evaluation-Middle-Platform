/**
 * `PG-02` 第 3 步「确定性规则算子」区块的单测。
 *
 * 这里挡的是三类「跑起来才发现」的问题：
 *  1. 勾了算子但提交上去的参数不符合契约 —— 服务端 400，用户前面填的全白费；
 *  2. `passThreshold` 该省的时候传了 `undefined`/`null` —— 前者在
 *     `exactOptionalPropertyTypes` 下是类型错，后者会被 Zod 拒；
 *  3. 执行顺序被重排 —— 「先跑哪个算子」变得不可预期。
 *
 * ⚠️ 三条阻塞校验**不在这里测**：它只有一份实现（`lib/preflight/index.ts`），
 * 已由 `tests/api.spec.ts` 的真栈用例覆盖。向导侧只调 `GET /api/runs/preflight`。
 */
import { describe, expect, it } from 'vitest';
import {
  EvaluatorConfig,
  RunEvaluatorInput,
  type BuiltinEvaluatorKey,
} from '@eval-platform/contracts';
import {
  RULE_OPERATOR_SPECS,
  buildEvaluatorInputs,
  defaultConfigOf,
  evaluatorKeysParam,
  operatorConfigError,
  operatorSpecOf,
  type SelectedEvaluator,
} from '../lib/ui/wizard.js';

const ALL_KEYS: readonly BuiltinEvaluatorKey[] = [
  'recall_at_k',
  'mrr',
  'ndcg_at_k',
  'json_schema',
  'regex',
  'numeric_fidelity',
];

describe('六个内置规则算子的清单', () => {
  it('恰好六个，顺序与 PG-02 / PG-07 一致', () => {
    expect(RULE_OPERATOR_SPECS.map((s) => s.key)).toEqual([...ALL_KEYS]);
  });

  it('展示名逐字取自 pages-and-flows.md PG-07', () => {
    expect(RULE_OPERATOR_SPECS.map((s) => s.label)).toEqual([
      'Recall@K',
      'MRR',
      'nDCG@K',
      'JSON Schema',
      '正则',
      '数值保真',
    ]);
  });

  it('不含 judge：M1 第 3 步只渲染确定性规则算子', () => {
    expect(RULE_OPERATOR_SPECS.some((s) => (s.key as string) === 'judge')).toBe(false);
    expect(operatorSpecOf('judge')).toBeUndefined();
  });

  it('每个算子都有一句说明和至少一个参数输入框', () => {
    for (const spec of RULE_OPERATOR_SPECS) {
      expect(spec.hint.length).toBeGreaterThan(0);
      expect(spec.fields.length).toBeGreaterThan(0);
    }
  });

  it('未知 key 取不到 spec（不静默返回一个默认值冒充内置）', () => {
    expect(operatorSpecOf('judge.v1')).toBeUndefined();
    expect(operatorSpecOf('')).toBeUndefined();
  });
});

describe('默认参数必须真的符合契约', () => {
  it('除 regex 外，其余五个默认配置直接过 EvaluatorConfig 校验', () => {
    // regex 被单列出来：`RegexConfig.pattern` 契约要求 min(1)，
    // 而默认值只能是空串（没有「合理的默认正则」）。这不是漏洞，
    // 是「默认值合法」这条断言在这一项上本来就不成立 —— 见下一条。
    for (const key of ALL_KEYS.filter((k) => k !== 'regex')) {
      const parsed = EvaluatorConfig.safeParse(defaultConfigOf(key));
      expect(parsed.success, `${key} 的默认配置不符合契约`).toBe(true);
    }
  });

  it('regex 的默认空 pattern 必须被契约拒 —— 所以要由 operatorConfigError 拦在提交前', () => {
    expect(EvaluatorConfig.safeParse(defaultConfigOf('regex')).success).toBe(false);
    expect(
      operatorConfigError({
        key: 'regex',
        config: defaultConfigOf('regex'),
        weight: 1,
        passThreshold: null,
      }),
    ).toBe('正则「正则表达式」的参数未填好');
  });

  it('默认配置的 key 与自己的 key 一致（不串台）', () => {
    for (const key of ALL_KEYS) {
      expect(defaultConfigOf(key).key).toBe(key);
    }
  });

  it('recall_at_k 默认 K=5、门槛 1', () => {
    expect(defaultConfigOf('recall_at_k')).toEqual({
      key: 'recall_at_k',
      k: 5,
      gradeThreshold: 1,
    });
  });

  it('nDCG@K 的折损函数锁死为 standard（首版不开放自定义）', () => {
    const c = defaultConfigOf('ndcg_at_k');
    expect(c.key === 'ndcg_at_k' && c.gainFormula).toBe('standard');
  });

  it('numeric_fidelity 默认 1% 容差，缺失即失败', () => {
    expect(defaultConfigOf('numeric_fidelity')).toEqual({
      key: 'numeric_fidelity',
      tolerance: 0.01,
      missingFails: true,
    });
  });
});

describe('buildEvaluatorInputs · 提交体', () => {
  const recall: SelectedEvaluator = {
    key: 'recall_at_k',
    config: { key: 'recall_at_k', k: 3, gradeThreshold: 1 },
    weight: 1,
    passThreshold: 0.8,
  };
  const regex: SelectedEvaluator = {
    key: 'regex',
    config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true },
    weight: 2,
    passThreshold: null,
  };

  it('保持用户添加顺序（顺序即执行顺序）', () => {
    expect(buildEvaluatorInputs([regex, recall]).map((e) => e.config.key)).toEqual([
      'regex',
      'recall_at_k',
    ]);
  });

  it('passThreshold 为 null 时**省略该字段**（不能传 undefined，也不能传 null）', () => {
    const [first] = buildEvaluatorInputs([regex]);
    expect(first).toEqual({
      config: regex.config,
      weight: 2,
    });
    expect(Object.hasOwn(first ?? {}, 'passThreshold')).toBe(false);
  });

  it('有阈值时原样带上', () => {
    const [first] = buildEvaluatorInputs([recall]);
    expect(first?.passThreshold).toBe(0.8);
  });

  it('产出能整个过 RunEvaluatorInput 校验', () => {
    const parsed = RunEvaluatorInput.array().safeParse(buildEvaluatorInputs([recall, regex]));
    expect(parsed.success).toBe(true);
  });

  it('空选择 ⇒ 空数组（不抛错，交给阻塞校验去提示）', () => {
    expect(buildEvaluatorInputs([])).toEqual([]);
  });
});

describe('operatorConfigError · 提交前的参数自检', () => {
  it('合法参数 ⇒ null', () => {
    expect(
      operatorConfigError({
        key: 'regex',
        config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true },
        weight: 1,
        passThreshold: null,
      }),
    ).toBeNull();
  });

  it('非法参数（pattern 空 / K 为 0）都能给出中文定位', () => {    expect(
      operatorConfigError({
        key: 'regex',
        config: { key: 'regex', pattern: '', caseSensitive: false, shouldMatch: true },
        weight: 1,
        passThreshold: null,
      }),
    ).toContain('正则');

    expect(
      operatorConfigError({
        key: 'recall_at_k',
        // 绕过 TS：模拟用户把 K 填成 0 之后的脏 state
        config: { key: 'recall_at_k', k: 0, gradeThreshold: 1 } as never,
        weight: 1,
        passThreshold: null,
      }),
    ).toBe('Recall@K「K 值」的参数未填好');
  });
});

describe('evaluatorKeysParam · 给 preflight 的查询串', () => {
  it('空选择返回 null，不返回空串', () => {
    // 拼 `&evaluatorKeys=` 会让服务端把空串当成一个 key
    expect(evaluatorKeysParam([])).toBeNull();
  });

  it('单个与多个都按逗号拼接', () => {
    const one: SelectedEvaluator = {
      key: 'regex',
      config: { key: 'regex', pattern: 'x', caseSensitive: false, shouldMatch: true },
      weight: 1,
      passThreshold: null,
    };
    const two: SelectedEvaluator = {
      key: 'mrr',
      config: { key: 'mrr', gradeThreshold: 1 },
      weight: 1,
      passThreshold: null,
    };
    expect(evaluatorKeysParam([one])).toBe('regex');
    expect(evaluatorKeysParam([one, two])).toBe('regex,mrr');
  });
});
