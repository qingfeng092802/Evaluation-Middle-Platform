/**
 * PG-08 展示逻辑单测（`US-009` / `US-010` 数据呈现口径）。
 *
 * 三类「写错了也照常渲染」的事只有断言拦得住：
 *  1. 横幅三态（已确认 / 指向别的 run / 无任何确认）——文案必须逐字来自契约；
 *  2. 变化列的语义反转：latency / cost 的 `higherIsBetter=false`，变大是**退化**
 *     （红），写死 delta>0 即绿就会把耗时恶化渲染成好;
 *  3. 雷达图 option：主题必须来自 Token（禁裸 hex），null 算子（缺侧）原样保留
 *     ——补 0 会把「没配算子」画成「0 分」。
 */
import { describe, expect, it } from 'vitest';
import type { CompareMetricRow, OperatorDiffRow } from '@eval-platform/contracts';
import { formatDelta, formatScore } from '../lib/format/index.js';
import {
  compareBannerView,
  metricDeltaView,
  metricLabel,
  metricValueText,
  operatorTableRows,
  radarOption,
  type ChartTheme,
} from '../lib/ui/compare.js';
import { CompareBanner } from '../components/compare/compare-banner.js';
import { MetricDeltaBadge } from '../components/ui/metric-delta-badge.js';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';

// ---------------------------------------------------------------------------
// 横幅三态（契约原文逐字透传）
// ---------------------------------------------------------------------------

describe('compareBannerView · 三态', () => {
  it('已确认基线：绿色 pass 氛围，无警告文案', () => {
    const v = compareBannerView(true, null);
    expect(v.tone).toBe('pass');
    expect(v.text).not.toContain('尚未确认');
  });

  it('有确认但比的是别的 run：提示横幅逐字透传契约 banner', () => {
    const v = compareBannerView(false, '尚未确认基线，本次对比仅供观察，不作为门禁依据');
    expect(v.tone).toBe('warn');
    expect(v.text).toBe('尚未确认基线，本次对比仅供观察，不作为门禁依据');
  });

  it('无任何确认：同样提示横幅', () => {
    const v = compareBannerView(false, '尚未确认基线，本次对比仅供观察，不作为门禁依据');
    expect(v.tone).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// 变化列视图（higherIsBetter 反转）
// ---------------------------------------------------------------------------

function metricRow(overrides: Partial<CompareMetricRow>): CompareMetricRow {
  return {
    metric: 'score_overall',
    label: 'score_overall',
    baseline: 0.5,
    current: 0.75,
    delta: 0.25,
    deltaPct: 0.5,
    higherIsBetter: true,
    ...overrides,
  };
}

describe('metricDeltaView · higherIsBetter 反转', () => {
  it('分数上升（higherIsBetter=true）→ pass ▲', () => {
    const v = metricDeltaView(metricRow({}));
    expect(v).toMatchObject({ kind: 'delta', variant: 'pass', arrow: '▲' });
    expect(v.kind === 'delta' && v.deltaText).toBe(formatDelta(0.25));
  });

  it('分数下降 → fail ▼', () => {
    const v = metricDeltaView(metricRow({ delta: -0.25, deltaPct: -0.5 }));
    expect(v).toMatchObject({ kind: 'delta', variant: 'fail', arrow: '▼' });
  });

  it('latency 上升（higherIsBetter=false）→ fail ▲（变大是退化，方向仍是向上）', () => {
    const v = metricDeltaView(
      metricRow({ metric: 'latency_p50_ms', delta: 50, deltaPct: 0.5, higherIsBetter: false }),
    );
    expect(v).toMatchObject({ kind: 'delta', variant: 'fail', arrow: '▲' });
    expect(v).toMatchObject({ ariaLabel: expect.stringContaining('变差') });
  });

  it('latency 下降（higherIsBetter=false）→ pass ▼（变小是改善）', () => {
    const v = metricDeltaView(
      metricRow({ metric: 'cost_total', delta: -2, deltaPct: -0.5, higherIsBetter: false }),
    );
    expect(v).toMatchObject({ kind: 'delta', variant: 'pass', arrow: '▼' });
    expect(v).toMatchObject({ ariaLabel: expect.stringContaining('变好') });
  });

  it('delta = 0 → muted、无箭头（零变化不冒充提升）', () => {
    const v = metricDeltaView(metricRow({ delta: 0, deltaPct: 0 }));
    expect(v).toMatchObject({ kind: 'delta', variant: 'muted', arrow: null });
  });

  it('baseline null → 无基线（不渲染 +0.0000）', () => {
    const v = metricDeltaView(metricRow({ baseline: null, current: 0.5, delta: null, deltaPct: null }));
    expect(v).toMatchObject({ kind: 'text', text: '无基线' });
  });

  it('current null → 不可比', () => {
    const v = metricDeltaView(metricRow({ baseline: 0.5, current: null, delta: null, deltaPct: null }));
    expect(v).toMatchObject({ kind: 'text', text: '不可比' });
  });
});

// ---------------------------------------------------------------------------
// 指标值文本（分数 / 延迟 / 成本各走既有格式化器）
// ---------------------------------------------------------------------------

describe('metricValueText', () => {
  it('分数类走 formatScore（4 位小数）', () => {
    expect(metricValueText('score_overall', 0.825)).toBe(formatScore(0.825));
  });
  it('延迟带 ms 单位', () => {
    expect(metricValueText('latency_p50_ms', 1234)).toBe('1234 ms');
  });
  it('null → —', () => {
    expect(metricValueText('pass_rate', null)).toBe('—');
  });
});

describe('metricLabel · 中文映射（裁定 1）', () => {
  it('六个指标全部映射为中文', () => {
    expect(metricLabel({ metric: 'score_overall', label: 'score_overall' })).toBe('综合得分');
    expect(metricLabel({ metric: 'pass_rate', label: 'pass_rate' })).toBe('通过率');
    expect(metricLabel({ metric: 'coverage', label: 'coverage' })).toBe('覆盖率');
    expect(metricLabel({ metric: 'latency_p50_ms', label: 'latency_p50_ms' })).toBe('P50 延迟');
    expect(metricLabel({ metric: 'latency_p95_ms', label: 'latency_p95_ms' })).toBe('P95 延迟');
    expect(metricLabel({ metric: 'cost_total', label: 'cost_total' })).toBe('Token 成本');
  });
  it('未知 key fallback 到契约 label 原文', () => {
    expect(metricLabel({ metric: 'future_metric', label: 'future_metric' })).toBe('future_metric');
    expect(metricLabel({ metric: 'future_metric', label: '自定义标签' })).toBe('自定义标签');
  });
});

// ---------------------------------------------------------------------------
// 雷达 option（主题来自 Token；null 原样保留）
// ---------------------------------------------------------------------------

const THEME: ChartTheme = {
  baseline: 'rgb(120,130,140)',
  current: 'rgb(10,20,30)',
  grid: 'rgb(200,200,200)',
  axis: 'rgb(180,180,180)',
  text: 'rgb(0,0,0)',
};

function opRow(overrides: Partial<OperatorDiffRow>): OperatorDiffRow {
  return {
    evaluatorKey: 'recall_at_k',
    kind: 'rule',
    baselineMean: 0.5,
    currentMean: 0.75,
    delta: 0.25,
    deltaPct: 0.5,
    baselineScoredCount: 2,
    currentScoredCount: 2,
    regressedCount: 0,
    improvedCount: 1,
    verdict: 'IMPROVED',
    ...overrides,
  };
}

describe('radarOption · 主题与空值', () => {
  it('两系列命名与配色来自 ChartTheme，图例齐全，option 无裸 hex', () => {
    const opt = radarOption([opRow({})], THEME) as {
      legend: { data: string[] };
      series: [
        { name: string; data: [{ value: number[] }]; lineStyle?: { color?: unknown }; itemStyle?: { color?: unknown } },
        { name: string; data: [{ value: number[] }]; lineStyle?: { color?: unknown }; itemStyle?: { color?: unknown } },
      ];
      radar: { indicator: Array<{ name: string }>; axisLine?: { lineStyle?: { color?: unknown } } };
    };
    expect(opt.legend.data).toEqual(['基线', '当前']);
    expect(opt.series).toHaveLength(2);
    expect(opt.series[0].name).toBe('基线');
    expect(opt.series[1].name).toBe('当前');
    expect(JSON.stringify(opt)).not.toContain('#');
    expect(JSON.stringify(opt)).toContain(THEME.baseline);
    expect(JSON.stringify(opt)).toContain(THEME.current);
    expect(opt.radar.indicator).toEqual([{ name: 'recall_at_k' }]);
    expect(opt.series[0].data[0].value).toEqual([0.5]);
    expect(opt.series[1].data[0].value).toEqual([0.75]);
  });

  it('缺侧算子（currentMean=null）→ 值原样 null，不补 0', () => {
    const opt = radarOption(
      [opRow({ evaluatorKey: 'judge_quality', currentMean: null, delta: null, deltaPct: null, verdict: 'NOT_COMPARABLE' })],
      THEME,
    ) as { series: [{ data: [{ value: Array<number | null> }] }, { data: [{ value: Array<number | null> }] }] };
    expect(opt.series[0].data[0].value).toEqual([0.5]);
    expect(opt.series[1].data[0].value).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// 表格孪生（图表红线 3：每张图必须有表格视图）
// ---------------------------------------------------------------------------

describe('operatorTableRows · 图表孪生', () => {
  it('逐算子给出可读文本：缺侧 不可比，其余走格式化器', () => {
    const rows = operatorTableRows([
      opRow({}),
      opRow({ evaluatorKey: 'judge_quality', currentMean: null, delta: null, deltaPct: null, verdict: 'NOT_COMPARABLE' }),
    ]);
    expect(rows[0]).toMatchObject({
      evaluatorKey: 'recall_at_k',
      baselineText: formatScore(0.5),
      currentText: formatScore(0.75),
      deltaText: formatDelta(0.25),
      verdict: 'IMPROVED',
    });
    expect(rows[1]).toMatchObject({
      evaluatorKey: 'judge_quality',
      baselineText: formatScore(0.5),
      currentText: '不可比',
      verdict: 'NOT_COMPARABLE',
    });
  });
});

// ---------------------------------------------------------------------------
// 组件渲染（SSR）：横幅与徽章
// ---------------------------------------------------------------------------

describe('CompareBanner / MetricDeltaBadge 渲染', () => {
  it('warn 横幅渲染契约原文', () => {
    const html = renderToStaticMarkup(
      React.createElement(CompareBanner, {
        tone: 'warn',
        text: '尚未确认基线，本次对比仅供观察，不作为门禁依据',
      }),
    );
    expect(html).toContain('尚未确认基线，本次对比仅供观察，不作为门禁依据');
  });

  it('pass 横幅不出现警告文案', () => {
    const html = renderToStaticMarkup(React.createElement(CompareBanner, { tone: 'pass', text: '对比基线为已确认基线' }));
    expect(html).toContain('对比基线为已确认基线');
    expect(html).not.toContain('仅供观察');
  });

  it('徽章：无基线渲染文字，不渲染 +0.0000', () => {
    const html = renderToStaticMarkup(
      React.createElement(MetricDeltaBadge, { view: { kind: 'text', text: '无基线' } }),
    );
    expect(html).toContain('无基线');
    expect(html).not.toContain('0.0000');
  });

  it('徽章：退化差值带 fail 语义与方向箭头', () => {
    const v = metricDeltaView(
      metricRow({ metric: 'latency_p50_ms', delta: 50, deltaPct: 0.5, higherIsBetter: false }),
    );
    const html = renderToStaticMarkup(
      React.createElement(MetricDeltaBadge, { view: v as never }),
    );
    expect(html).toContain('▲');
    expect(html).toContain('+');
    expect(html).toContain('fail');
  });
});
