/**
 * 数字格式表（`DESIGN.md` §3.3）的黄金单测。
 *
 * 格式统一是 `tabular-nums` 对齐的**前置条件**：`0.995` / `0.9952` / `0.99` 混排时，
 * 即使等宽数字也会让小数点落在不同列。因此每个函数都对「小数位 / 千分位 / 符号 / 单位」
 * 逐项断言，而不是只说「看起来对」。
 *
 * `null` 一律渲染为 `—`：**绝不把缺失值当 0**（`PG-03` 的 `FAILED` 行就是这样）。
 */
import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatDelta,
  formatDeltaPct,
  formatLatency,
  formatRate,
  formatScore,
  formatTimestamp,
  formatTokens,
  truncateHash,
} from '../lib/format/index.js';

describe('formatScore · 固定 4 位小数', () => {
  it('补齐尾零', () => {
    expect(formatScore(0.9952)).toBe('0.9952');
    expect(formatScore(0.6)).toBe('0.6000');
    expect(formatScore(1)).toBe('1.0000');
    expect(formatScore(0)).toBe('0.0000');
  });

  it('null ⇒ 长破折号，不是 0.0000', () => {
    expect(formatScore(null)).toBe('—');
  });
});

describe('formatDelta · 带符号 4 位 + 方向箭头', () => {
  it('上升带 + 与 ▲', () => {
    expect(formatDelta(0.0366)).toBe('+0.0366 ▲');
  });

  it('下降带 - 与 ▼', () => {
    expect(formatDelta(-0.042)).toBe('-0.0420 ▼');
  });

  it('零变化不加箭头', () => {
    expect(formatDelta(0)).toBe('0.0000');
  });

  it('null ⇒ 长破折号', () => {
    expect(formatDelta(null)).toBe('—');
  });
});

describe('formatRate · 固定 2 位 + %，不省尾零', () => {
  it('84.5% 必须写成 84.50%', () => {
    expect(formatRate(0.845)).toBe('84.50%');
    expect(formatRate(1)).toBe('100.00%');
    expect(formatRate(0)).toBe('0.00%');
  });

  it('null ⇒ 长破折号（run 无任何 passThreshold 时 pass_rate 为 NULL）', () => {
    expect(formatRate(null)).toBe('—');
  });
});

describe('formatDeltaPct · 带符号 2 位', () => {
  it('正负都带符号', () => {
    expect(formatDeltaPct(0.11)).toBe('+11.00%');
    expect(formatDeltaPct(-0.042)).toBe('-4.20%');
    expect(formatDeltaPct(0)).toBe('0.00%');
  });

  it('null ⇒ 长破折号', () => {
    expect(formatDeltaPct(null)).toBe('—');
  });
});

describe('formatLatency · 整数 + 千分位 + ms', () => {
  it('千分位分组', () => {
    expect(formatLatency(1240)).toBe('1,240 ms');
    expect(formatLatency(0)).toBe('0 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1234567)).toBe('1,234,567 ms');
  });

  it('小数四舍五入到整数', () => {
    expect(formatLatency(12.6)).toBe('13 ms');
  });

  it('null ⇒ 长破折号', () => {
    expect(formatLatency(null)).toBe('—');
  });
});

describe('formatTokens · 整数 + 千分位，无单位后缀', () => {
  it('千分位分组', () => {
    expect(formatTokens(128450)).toBe('128,450');
    expect(formatTokens(0)).toBe('0');
  });

  it('null ⇒ 长破折号', () => {
    expect(formatTokens(null)).toBe('—');
  });
});

describe('formatCost · 单条 4 位 / 汇总 2 位', () => {
  it('单条成本 4 位小数', () => {
    expect(formatCost(0.0428, 'case')).toBe('$0.0428');
    expect(formatCost(0, 'case')).toBe('$0.0000');
  });

  it('汇总成本 2 位小数', () => {
    expect(formatCost(12.478, 'total')).toBe('$12.48');
    expect(formatCost(0, 'total')).toBe('$0.00');
  });

  it('null ⇒ 长破折号', () => {
    expect(formatCost(null, 'case')).toBe('—');
    expect(formatCost(null, 'total')).toBe('—');
  });
});

describe('formatTimestamp · YYYY-MM-DD HH:mm:ss（本地时区）', () => {
  it('按本地时间渲染，补零', () => {
    const iso = new Date(2026, 10, 7, 14, 32, 8).toISOString();
    expect(formatTimestamp(iso)).toBe('2026-11-07 14:32:08');
  });

  it('个位月日时分秒补零', () => {
    const iso = new Date(2026, 0, 5, 3, 4, 9).toISOString();
    expect(formatTimestamp(iso)).toBe('2026-01-05 03:04:09');
  });

  it('null ⇒ 长破折号', () => {
    expect(formatTimestamp(null)).toBe('—');
  });
});

describe('truncateHash · 超 12 位中间省略', () => {
  it('64 位 hash 取前 8 + 后 4', () => {
    expect(truncateHash('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e9f0e')).toBe(
      'a1b2c3d4…9f0e',
    );
  });

  it('恰好 12 位不省略', () => {
    expect(truncateHash('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
  });

  it('空串原样返回', () => {
    expect(truncateHash('')).toBe('');
  });
});
