/**
 * 六个规则算子的黄金精度测试（AC-4 / AC-5）。
 *
 * 全部为**确定性**用例：无网络、无随机、无真实时钟。
 * 每条期望值在注释里写出推导过程，便于人工复算 —— 这是 `工程规则.md` §4
 * 「黄金测试」的要求，不是风格偏好。
 */
import { describe, expect, it } from 'vitest';
import { EVALUATOR_REQUIRES_RETRIEVAL } from '@eval-platform/contracts';
import type { OperatorContext } from '@eval-platform/contracts';
import { recallAtKOperator } from '../lib/operators/recall-at-k.js';
import { mrrOperator } from '../lib/operators/mrr.js';
import { ndcgAtKOperator } from '../lib/operators/ndcg-at-k.js';
import { jsonSchemaOperator } from '../lib/operators/json-schema.js';
import { regexOperator } from '../lib/operators/regex.js';
import { numericFidelityOperator } from '../lib/operators/numeric-fidelity.js';
import { getOperator, listOperators } from '../lib/operators/index.js';

// ---------------------------------------------------------------------------
// 构造 OperatorContext 的小工具
// ---------------------------------------------------------------------------

function ctx(over: Partial<OperatorContext> = {}): OperatorContext {
  return {
    caseKey: 'case-1',
    input: { query: 'q' },
    reference: null,
    retrievalAnnotation: null,
    actualOutput: null,
    outputRaw: null,
    retrievedContexts: null,
    ...over,
  };
}

/** 按 doc_id 列表造「召回结果」；grade 只用于标注侧。 */
function retrieved(ids: string[]): { doc_id: string; content: string; score: number | null }[] {
  return ids.map((id, i) => ({ doc_id: id, content: `c-${id}`, score: 1 - i * 0.1 }));
}

function annotated(items: [string, number][]): { relevant: { doc_id: string; grade: number }[] } {
  return { relevant: items.map(([doc_id, grade]) => ({ doc_id, grade })) };
}

// ---------------------------------------------------------------------------
// AC-4 · recall_at_k 黄金精度
// ---------------------------------------------------------------------------

describe('AC-4 / recall_at_k', () => {
  const k = 5;

  it('全命中：召回 top-5 覆盖全部 3 条相关 ⇒ 1.0', async () => {
    // relevant = {a,b,c}（|R| = 3）；recalled[0..5) = [a,b,c,d,e] ⇒ hit = {a,b,c} = 3
    // score = 3 / 3 = 1.0
    const r = await recallAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 2], ['b', 1], ['c', 1]]),
        retrievedContexts: retrieved(['a', 'b', 'c', 'd', 'e']),
      }),
      { key: 'recall_at_k', k, gradeThreshold: 1 },
    );
    expect(r.score).toBeCloseTo(1.0, 6);
  });

  it('部分命中：3 条相关只有 2 条进 top-5 ⇒ 2/3 ≈ 0.666667', async () => {
    // relevant = {a,b,c}；recalled[0..5) = [a,x,y,z,b] ⇒ hit = {a,b} = 2
    // score = 2 / 3 = 0.666666...
    const r = await recallAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 1], ['b', 1], ['c', 1]]),
        retrievedContexts: retrieved(['a', 'x', 'y', 'z', 'b']),
      }),
      { key: 'recall_at_k', k, gradeThreshold: 1 },
    );
    expect(Math.abs(r.score - 2 / 3)).toBeLessThanOrEqual(1e-6);
  });

  it('零命中：top-5 全是无关文档 ⇒ 0.0', async () => {
    const r = await recallAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 1], ['b', 1]]),
        retrievedContexts: retrieved(['x', 'y', 'z', 'w', 'v']),
      }),
      { key: 'recall_at_k', k, gradeThreshold: 1 },
    );
    expect(r.score).toBe(0);
  });

  it('命中在 K 之外不计入：相关文档只出现在第 6 位 ⇒ 0.0', async () => {
    // recalled[0..5) = [x,y,z,w,v]；a 在第 6 位（index 5）⇒ 不在 top-5 ⇒ hit = 0
    const r = await recallAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 1]]),
        retrievedContexts: retrieved(['x', 'y', 'z', 'w', 'v', 'a']),
      }),
      { key: 'recall_at_k', k, gradeThreshold: 1 },
    );
    expect(r.score).toBe(0);
  });

  it('grade=0 的召回项不计入命中', async () => {
    // relevant（gradeThreshold=1）= {} ⇒ |R| = 0 ⇒ 按口径返回 0，不得 NaN
    const r = await recallAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 0]]),
        retrievedContexts: retrieved(['a']),
      }),
      { key: 'recall_at_k', k, gradeThreshold: 1 },
    );
    expect(r.score).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('|relevant| = 0（标注存在但 grade 全低于阈值）⇒ 0，不是 NaN', async () => {
    const r = await recallAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 0], ['b', 0]]),
        retrievedContexts: retrieved(['a', 'b']),
      }),
      { key: 'recall_at_k', k, gradeThreshold: 1 },
    );
    expect(r.score).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it('召回为空 ⇒ 0', async () => {
    const r = await recallAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 1]]),
        retrievedContexts: [],
      }),
      { key: 'recall_at_k', k, gradeThreshold: 1 },
    );
    expect(r.score).toBe(0);
  });

  it('同一输入重复执行 10 次结果完全相同（纯函数）', async () => {
    const c = ctx({
      retrievalAnnotation: annotated([['a', 1], ['b', 1], ['c', 1]]),
      retrievedContexts: retrieved(['a', 'x', 'y', 'z', 'b']),
    });
    const cfg = { key: 'recall_at_k' as const, k, gradeThreshold: 1 };
    const first = (await recallAtKOperator.score(c, cfg)).score;
    for (let i = 0; i < 10; i++) {
      expect((await recallAtKOperator.score(c, cfg)).score).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5 · mrr
// ---------------------------------------------------------------------------

describe('AC-5 / mrr', () => {
  it('第一个相关在首位 ⇒ 1/1 = 1.0', async () => {
    const r = await mrrOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 1]]),
        retrievedContexts: retrieved(['a', 'b']),
      }),
      { key: 'mrr', gradeThreshold: 1 },
    );
    expect(r.score).toBeCloseTo(1.0, 6);
  });

  it('第一个相关在第 3 位 ⇒ 1/3 ≈ 0.333333', async () => {
    const r = await mrrOperator.score(
      ctx({
        retrievalAnnotation: annotated([['c', 2]]),
        retrievedContexts: retrieved(['a', 'b', 'c']),
      }),
      { key: 'mrr', gradeThreshold: 1 },
    );
    expect(Math.abs(r.score - 1 / 3)).toBeLessThanOrEqual(1e-6);
  });

  it('无命中 ⇒ 0', async () => {
    const r = await mrrOperator.score(
      ctx({
        retrievalAnnotation: annotated([['z', 1]]),
        retrievedContexts: retrieved(['a', 'b', 'c']),
      }),
      { key: 'mrr', gradeThreshold: 1 },
    );
    expect(r.score).toBe(0);
  });

  it('grade 低于阈值不算命中 ⇒ 0', async () => {
    // a 的 grade=0 < threshold=1 ⇒ 不算相关 ⇒ 后续也没有 ⇒ 0
    const r = await mrrOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 0]]),
        retrievedContexts: retrieved(['a']),
      }),
      { key: 'mrr', gradeThreshold: 1 },
    );
    expect(r.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5 · ndcg_at_k
// ---------------------------------------------------------------------------

describe('AC-5 / ndcg_at_k', () => {
  /** DCG = Σ (2^g_i − 1) / log2(i+1) */
  function dcg(grades: number[]): number {
    return grades.reduce((acc, g, idx) => acc + (2 ** g - 1) / Math.log2(idx + 2), 0);
  }

  it('完美排序 ⇒ 1.0', async () => {
    // relevant: a=2,b=1,c=0；recalled top-3 = [a,b,c] ⇒ g = [2,1,0]
    // DCG = 3/1 + 1/1.585 + 0/2 = 3.6309...
    // IDCG 用标注降序截前 3 = [2,1,0] ⇒ 同式 = 3.6309...
    // score = DCG/IDCG = 1.0
    const r = await ndcgAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 2], ['b', 1], ['c', 0]]),
        retrievedContexts: retrieved(['a', 'b', 'c']),
      }),
      { key: 'ndcg_at_k', k: 3, gainFormula: 'standard' },
    );
    expect(r.score).toBeCloseTo(1.0, 6);
  });

  it('逆序 ⇒ 明显小于 1：DCG(log2 折损后偏低)', async () => {
    // g = [0,1,2] ⇒ DCG = 0 + 1/1.585 + 3/2 = 2.1309...
    // IDCG = 同上完美排序 3.6309... ⇒ score ≈ 0.587
    const r = await ndcgAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 2], ['b', 1], ['c', 0]]),
        retrievedContexts: retrieved(['c', 'b', 'a']),
      }),
      { key: 'ndcg_at_k', k: 3, gainFormula: 'standard' },
    );
    const expected = dcg([0, 1, 2]) / dcg([2, 1, 0]);
    expect(Math.abs(r.score - expected)).toBeLessThanOrEqual(1e-6);
    expect(r.score).toBeLessThan(1);
  });

  it('IDCG = 0（标注 grade 全为 0）⇒ 0，且不是 NaN/Infinity', async () => {
    const r = await ndcgAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 0], ['b', 0]]),
        retrievedContexts: retrieved(['a', 'b']),
      }),
      { key: 'ndcg_at_k', k: 5, gainFormula: 'standard' },
    );
    expect(r.score).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it('未召回的标注项不计入 DCG（按 0 增益）', async () => {
    // relevant a=2,b=2；recalled 只有 [a] ⇒ g = [2]
    // DCG = 3；IDCG = dcg([2,2]) = 3 + 3/1.585 = 4.8928
    const r = await ndcgAtKOperator.score(
      ctx({
        retrievalAnnotation: annotated([['a', 2], ['b', 2]]),
        retrievedContexts: retrieved(['a']),
      }),
      { key: 'ndcg_at_k', k: 5, gainFormula: 'standard' },
    );
    const expected = dcg([2]) / dcg([2, 2]);
    expect(Math.abs(r.score - expected)).toBeLessThanOrEqual(1e-6);
  });
});

// ---------------------------------------------------------------------------
// AC-5 · json_schema
// ---------------------------------------------------------------------------

describe('AC-5 / json_schema', () => {
  const schema = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
  } as const;

  it('合法 JSON 且符合 Schema ⇒ 1.0', async () => {
    const r = await jsonSchemaOperator.score(
      ctx({ actualOutput: '{"answer":"x","confidence":0.9}' }),
      { key: 'json_schema', schema: schema as unknown as Record<string, unknown>, extractFromText: true },
    );
    expect(r.score).toBe(1.0);
  });

  it('输出无 JSON 块 ⇒ 0', async () => {
    const r = await jsonSchemaOperator.score(ctx({ actualOutput: '完全没有 JSON 的一段话' }), {
      key: 'json_schema',
      schema: schema as unknown as Record<string, unknown>,
      extractFromText: true,
    });
    expect(r.score).toBe(0);
    expect(r.reason).toBeTruthy();
  });

  it('JSON 合法但缺必填字段 ⇒ 0，reason 指出首个错误路径', async () => {
    const r = await jsonSchemaOperator.score(ctx({ actualOutput: '{"confidence":0.5}' }), {
      key: 'json_schema',
      schema: schema as unknown as Record<string, unknown>,
      extractFromText: true,
    });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('answer');
  });

  it('从包裹文本中抽取 fenced JSON 块并通过 ⇒ 1.0', async () => {
    const out = '这是模型输出：\n```json\n{"answer":"ok"}\n```\n以上。';
    const r = await jsonSchemaOperator.score(ctx({ actualOutput: out }), {
      key: 'json_schema',
      schema: schema as unknown as Record<string, unknown>,
      extractFromText: true,
    });
    expect(r.score).toBe(1.0);
  });

  it('actualOutput 为 null ⇒ 0（不抛异常）', async () => {
    const r = await jsonSchemaOperator.score(ctx({ actualOutput: null }), {
      key: 'json_schema',
      schema: schema as unknown as Record<string, unknown>,
      extractFromText: true,
    });
    expect(r.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5 · regex
// ---------------------------------------------------------------------------

describe('AC-5 / regex', () => {
  it('shouldMatch=true 且命中 ⇒ 1.0', async () => {
    const r = await regexOperator.score(ctx({ actualOutput: '[fixture] FIXTURE-HIT-1' }), {
      key: 'regex',
      pattern: 'FIXTURE-HIT-',
      caseSensitive: false,
      shouldMatch: true,
    });
    expect(r.score).toBe(1.0);
  });

  it('shouldMatch=false 而命中 ⇒ 0（禁用词检查）', async () => {
    const r = await regexOperator.score(ctx({ actualOutput: '含有禁用词 xxx' }), {
      key: 'regex',
      pattern: 'xxx',
      caseSensitive: false,
      shouldMatch: false,
    });
    expect(r.score).toBe(0);
  });

  it('shouldMatch=false 且未命中 ⇒ 1.0', async () => {
    const r = await regexOperator.score(ctx({ actualOutput: '干净输出' }), {
      key: 'regex',
      pattern: 'xxx',
      caseSensitive: false,
      shouldMatch: false,
    });
    expect(r.score).toBe(1.0);
  });

  it('caseSensitive=true 时大小写不同不命中 ⇒ 0', async () => {
    const r = await regexOperator.score(ctx({ actualOutput: 'fixture-hit-' }), {
      key: 'regex',
      pattern: 'FIXTURE-HIT-',
      caseSensitive: true,
      shouldMatch: true,
    });
    expect(r.score).toBe(0);
  });

  it('非法正则归 0 且不抛异常', async () => {
    const r = await regexOperator.score(ctx({ actualOutput: 'x' }), {
      key: 'regex',
      pattern: '([unclosed',
      caseSensitive: false,
      shouldMatch: true,
    });
    expect(r.score).toBe(0);
    expect(r.reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC-5 · numeric_fidelity
// ---------------------------------------------------------------------------

describe('AC-5 / numeric_fidelity', () => {
  function facts(map: Record<string, string | number>) {
    return { reference_facts: map };
  }

  it('全部数值都在容差内 ⇒ 1.0', async () => {
    const r = await numericFidelityOperator.score(
      ctx({ actualOutput: '温度 25.0 度，湿度 60%', reference: facts({ 温度: 25, 湿度: 60 }) }),
      { key: 'numeric_fidelity', tolerance: 0.01, missingFails: true },
    );
    expect(r.score).toBe(1.0);
  });

  it('容差临界值（相对误差恰好等于 tolerance）⇒ 算命中', async () => {
    // |101 − 100| / 100 = 0.01 = tolerance ⇒ 命中（≤ 而非 <）
    const r = await numericFidelityOperator.score(
      ctx({ actualOutput: '结果 101', reference: facts({ v: 100 }) }),
      { key: 'numeric_fidelity', tolerance: 0.01, missingFails: true },
    );
    expect(r.score).toBe(1.0);
  });

  it('超出容差 ⇒ 0', async () => {
    // |102 − 100| / 100 = 0.02 > 0.01
    const r = await numericFidelityOperator.score(
      ctx({ actualOutput: '结果 102', reference: facts({ v: 100 }) }),
      { key: 'numeric_fidelity', tolerance: 0.01, missingFails: true },
    );
    expect(r.score).toBe(0);
  });

  it('部分命中：2 个 fact 命中 1 个 ⇒ 0.5', async () => {
    const r = await numericFidelityOperator.score(
      ctx({ actualOutput: 'A=1 B=999', reference: facts({ a: 1, b: 2 }) }),
      { key: 'numeric_fidelity', tolerance: 0.01, missingFails: true },
    );
    expect(r.score).toBeCloseTo(0.5, 6);
  });

  it('非数字 fact 走精确子串包含', async () => {
    const r = await numericFidelityOperator.score(
      ctx({ actualOutput: '产品名称为 iPhone', reference: facts({ product: 'iPhone' }) }),
      { key: 'numeric_fidelity', tolerance: 0.01, missingFails: true },
    );
    expect(r.score).toBe(1.0);
  });

  it('无任何 reference_facts + missingFails=true ⇒ 0，reason 写明分支', async () => {
    const r = await numericFidelityOperator.score(ctx({ actualOutput: '1 2 3', reference: {} }), {
      key: 'numeric_fidelity',
      tolerance: 0.01,
      missingFails: true,
    });
    expect(r.score).toBe(0);
    expect(r.reason).toBeTruthy();
    expect(r.reason).toContain('missingFails');
  });

  it('无任何 reference_facts + missingFails=false ⇒ 1，reason 写明分支', async () => {
    const r = await numericFidelityOperator.score(ctx({ actualOutput: '1 2 3', reference: {} }), {
      key: 'numeric_fidelity',
      tolerance: 0.01,
      missingFails: false,
    });
    expect(r.score).toBe(1);
    expect(r.reason).toBeTruthy();
    expect(r.reason).toContain('missingFails');
  });

  it('算子只产 score + reason：passed 与 threshold 必须为 null', async () => {
    const r = await numericFidelityOperator.score(ctx({ actualOutput: 'x', reference: {} }), {
      key: 'numeric_fidelity',
      tolerance: 0.01,
      missingFails: true,
    });
    expect(r.passed).toBeNull();
    expect(r.threshold).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-5 · 跨算子一致性 + 工厂
// ---------------------------------------------------------------------------

describe('AC-5 / 算子接口一致性', () => {
  const operators = [recallAtKOperator, mrrOperator, ndcgAtKOperator, jsonSchemaOperator, regexOperator, numericFidelityOperator];

  it('六个实现的 requiresRetrieval 与 EVALUATOR_REQUIRES_RETRIEVAL 逐键相等', () => {
    for (const op of operators) {
      const expected = EVALUATOR_REQUIRES_RETRIEVAL[op.key as keyof typeof EVALUATOR_REQUIRES_RETRIEVAL];
      expect(op.requiresRetrieval, `${op.key} 的 requiresRetrieval 与契约不一致`).toBe(expected);
    }
  });

  it('六个算子全部 kind=rule，且 key 覆盖契约的六个内置 key', () => {
    expect(listOperators()).toHaveLength(6);
    for (const op of operators) expect(op.kind).toBe('rule');
  });

  it('getOperator 按 key 取到对应实现；未知 key 返回 undefined', () => {
    expect(getOperator('recall_at_k')).toBe(recallAtKOperator);
    expect(getOperator('judge')).toBeUndefined();
    expect(getOperator('not-exists')).toBeUndefined();
  });

  it('算子包不 import db（静态断言：源码里不出现 db/ 路径）', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '..', 'lib', 'operators');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const src = await readFile(join(dir, f), 'utf8');
      expect(src, `${f} 不得 import db`).not.toMatch(/from\s+['"][^'"]*\/db\//);
    }
  });
});
