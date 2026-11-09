/**
 * `npm run check:tokens` 的自测（`[FE-01]` DoD 第 1 条）。
 *
 * DoD 原文：「人为写一个 `#ff0000` 字面量 → Linter **报错**（测试该门禁真的生效）」。
 * 一个门禁脚本如果不被测试，它很可能只是「存在」而从不生效——
 * 所以这里直接喂字符串给扫描函数，断言它能抓到每一类违规，并且**不误报**合法写法。
 */
import { describe, expect, it } from 'vitest';
import { scanSource, scanSources } from '../scripts/check-tokens.mjs';

describe('scanSource · 必须抓到违规', () => {
  it('裸 6 位 hex', () => {
    const r = scanSource('a.tsx', 'const x = "#ff0000";');
    expect(r).toHaveLength(1);
    expect(r[0]?.rule).toBe('hex');
  });

  it('3 位 hex', () => {
    expect(scanSource('a.tsx', 'color: "#fff"').length).toBeGreaterThan(0);
  });

  it('8 位 hex（带 alpha）', () => {
    expect(scanSource('a.tsx', 'color: "#ff000080"').length).toBeGreaterThan(0);
  });

  it('rgb() 字面量', () => {
    const r = scanSource('a.tsx', 'style: "rgb(255, 0, 0)"');
    expect(r.some((i) => i.rule === 'rgb')).toBe(true);
  });

  it('hsl() 字面量', () => {
    const r = scanSource('a.tsx', 'style: "hsl(0 100% 50%)"');
    expect(r.some((i) => i.rule === 'hsl')).toBe(true);
  });

  it('gradient()', () => {
    const r = scanSource('a.tsx', 'className="bg-[linear-gradient(90deg,#000,#fff)]"');
    expect(r.some((i) => i.rule === 'gradient')).toBe(true);
  });

  it('内联 style 对象（AS-2）', () => {
    const r = scanSource('a.tsx', 'return <div style={{ color: token }} />;');
    expect(r.some((i) => i.rule === 'inline-style')).toBe(true);
  });

  it('记录行号（1-based）', () => {
    const source = 'line one\nline two\nconst c = "#ff0000";';
    const r = scanSource('a.tsx', source);
    expect(r[0]?.line).toBe(3);
  });

  it('一行多处违规各自记一条', () => {
    const r = scanSource('a.tsx', 'x = "#ff0000"; y = "rgb(0,0,0)";');
    expect(r.length).toBe(2);
  });
});

describe('scanSource · 不得误报', () => {
  it('语义 Token 类名', () => {
    expect(scanSource('a.tsx', 'className="bg-eval-pass-bg text-eval-pass"')).toEqual([]);
  });

  it('hsl(var(--token)) 是合法写法（tailwind.config.ts 里只允许这个）', () => {
    expect(scanSource('a.tsx', "border: 'hsl(var(--border))'")).toEqual([]);
  });

  it('ID 选择器 / 注释里的 # 不是颜色', () => {
    expect(scanSource('a.tsx', 'const anchor = "#section";')).toEqual([]);
  });

  it('CSS 变量名里的数字', () => {
    expect(scanSource('a.tsx', 'var(--chart-1)')).toEqual([]);
  });

  it('字符串里出现 4 位 #abcd 但不符合颜色语境（如 slug）', () => {
    // 5 位不是合法 hex 长度，不应命中
    expect(scanSource('a.tsx', '"#abcde"')).toEqual([]);
  });
});

describe('scanSources · 多文件聚合', () => {
  it('文件名与行号一起返回', () => {
    const results = scanSources([
      { file: 'components/a.tsx', source: 'const c = "#ff0000";' },
      { file: 'components/b.tsx', source: 'const ok = "bg-muted";' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.file).toBe('components/a.tsx');
    expect(results[0]?.line).toBe(1);
  });

  it('空数组 ⇒ 无结果', () => {
    expect(scanSources([])).toEqual([]);
  });
});
