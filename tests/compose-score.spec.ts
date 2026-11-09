/**
 * `composeCaseScore()` 合并口径的黄金测试（`[BE-02]` 交付物 4）。
 *
 * 被测算子合并函数是契约层现成实现（`contracts/src/eval-contracts.ts`），
 * 我们不改契约（C-1），只把 SPEC 锁定口径钉成测试：加权均分、`weight=0` 只记录不计入、
 * AND 判定、`weight` 全为 0 时 `score=null`、`hasConflict` 三种情形。
 */
import { describe, expect, it } from 'vitest';
import { composeCaseScore, roundScore } from '@eval-platform/contracts';
import type { OperatorScore } from '@eval-platform/contracts';

/** 造一条算子结论；`passed` 缺省为 `null`（未设阈值）。 */
function op(over: Partial<OperatorScore> & { key: string }): OperatorScore {
  return {
    key: over.key,
    kind: over.kind ?? 'rule',
    score: over.score ?? 1,
    passed: over.passed ?? null,
    threshold: over.threshold ?? null,
    weight: over.weight ?? 1,
    reason: over.reason ?? 'r',
  };
}

describe('composeCaseScore / 加权均分', () => {
  it('等权 2 个算子：[1.0, 0.5] ⇒ 0.75', () => {
    // (1.0*1 + 0.5*1) / (1+1) = 1.5 / 2 = 0.75
    const r = composeCaseScore([op({ key: 'a', score: 1 }), op({ key: 'b', score: 0.5 })]);
    expect(r.score).toBe(0.75);
  });

  it('不等权：[1.0 w=3, 0.5 w=1] ⇒ 0.875', () => {
    // (1.0*3 + 0.5*1) / (3+1) = 3.5 / 4 = 0.875
    const r = composeCaseScore([
      op({ key: 'a', score: 1, weight: 3 }),
      op({ key: 'b', score: 0.5, weight: 1 }),
    ]);
    expect(r.score).toBe(0.875);
  });

  it('结果按 numeric(10,6) 取整，不把浮点尾数写进库', () => {
    // (2/3*1 + 2/3*1) / (1+1) = (4/3)/2 = 2/3 = 0.6666666666666666...
    // 落库必须是 0.666667，而不是 0.6666666666666666
    const r = composeCaseScore([
      op({ key: 'a', score: 2 / 3 }),
      op({ key: 'b', score: 2 / 3 }),
    ]);
    expect(r.score).toBe(roundScore(2 / 3));
    expect(r.score).toBe(0.666667);
  });
});

describe('composeCaseScore / weight = 0', () => {
  it('weight=0 的算子只记录、不计入均分与 AND 判定', () => {
    // 计权只有 a（1.0 w=1）⇒ score=1.0；b 的 0 分与 passed=false 都不影响
    const r = composeCaseScore([
      op({ key: 'a', score: 1, weight: 1, passed: true, threshold: 0.5 }),
      op({ key: 'b', score: 0, weight: 0, passed: false, threshold: 0.5 }),
    ]);
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.hasConflict).toBe(false);
    // 原始结论全量保留，前端要能展开看到被忽略的那一条
    expect(r.operators).toHaveLength(2);
  });

  it('weight 全为 0 ⇒ score=null、passed=null，但不是报错', () => {
    const r = composeCaseScore([
      op({ key: 'a', score: 1, weight: 0, passed: true }),
      op({ key: 'b', score: 0, weight: 0, passed: false }),
    ]);
    expect(r.score).toBeNull();
    expect(r.passed).toBeNull();
    expect(r.hasConflict).toBe(false);
  });
});

describe('composeCaseScore / AND 判定', () => {
  it('全部通过 ⇒ passed=true', () => {
    const r = composeCaseScore([
      op({ key: 'a', score: 0.9, passed: true, threshold: 0.8 }),
      op({ key: 'b', score: 1, passed: true, threshold: 0.5 }),
    ]);
    expect(r.passed).toBe(true);
  });

  it('一个通过一个不通过 ⇒ passed=false（硬指标不被高分稀释）', () => {
    const r = composeCaseScore([
      op({ key: 'recall', score: 0.95, passed: true, threshold: 0.8 }),
      op({ key: 'schema', score: 0.5, passed: false, threshold: 0.9 }),
    ]);
    expect(r.passed).toBe(false);
  });

  it('没有任何算子设阈值（passed 全为 null）⇒ passed=null', () => {
    const r = composeCaseScore([op({ key: 'a', score: 0.7 }), op({ key: 'b', score: 0.3 })]);
    expect(r.passed).toBeNull();
    expect(r.score).toBe(0.5);
  });

  it('只有部分算子设阈值时，只按这些算子判 AND', () => {
    // b 无阈值 ⇒ 不参与 AND；仅 a=true ⇒ passed=true
    const r = composeCaseScore([
      op({ key: 'a', score: 0.9, passed: true, threshold: 0.8 }),
      op({ key: 'b', score: 0 }),
    ]);
    expect(r.passed).toBe(true);
  });
});

describe('composeCaseScore / hasConflict 的三种情形', () => {
  it('情形一：一通过一不通过 ⇒ hasConflict=true，conflictNote 列出双方 key', () => {
    const r = composeCaseScore([
      op({ key: 'regex', score: 1, passed: true, threshold: 0.5 }),
      op({ key: 'judge', score: 0.9, passed: false, threshold: 0.95 }),
    ]);
    expect(r.hasConflict).toBe(true);
    expect(r.conflictNote).toBeTruthy();
    expect(r.conflictNote).toContain('regex');
    expect(r.conflictNote).toContain('judge');
  });

  it('情形二：全部通过 ⇒ hasConflict=false', () => {
    const r = composeCaseScore([
      op({ key: 'a', score: 1, passed: true, threshold: 0.5 }),
      op({ key: 'b', score: 0.9, passed: true, threshold: 0.5 }),
    ]);
    expect(r.hasConflict).toBe(false);
    expect(r.conflictNote).toBeNull();
  });

  it('情形三：全部不通过 ⇒ hasConflict=false（分歧才算冲突）', () => {
    const r = composeCaseScore([
      op({ key: 'a', score: 0.1, passed: false, threshold: 0.5 }),
      op({ key: 'b', score: 0.2, passed: false, threshold: 0.5 }),
    ]);
    expect(r.hasConflict).toBe(false);
    expect(r.conflictNote).toBeNull();
  });

  it('全部为 null（无阈值）⇒ hasConflict=false', () => {
    const r = composeCaseScore([op({ key: 'a', score: 0.5 }), op({ key: 'b', score: 0.5 })]);
    expect(r.hasConflict).toBe(false);
  });
});

describe('composeCaseScore / 契约形状', () => {
  it('空算子列表 ⇒ score=null、passed=null、hasConflict=false（不抛异常）', () => {
    const r = composeCaseScore([]);
    expect(r.score).toBeNull();
    expect(r.passed).toBeNull();
    expect(r.hasConflict).toBe(false);
    expect(r.operators).toEqual([]);
  });

  it('单条得分恒落在 [0,1]', () => {
    const r = composeCaseScore([op({ key: 'a', score: 0 }), op({ key: 'b', score: 1 })]);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});
