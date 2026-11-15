/**
 * PG-08 展示逻辑（纯函数：无 DOM、无 echarts 依赖）。
 *
 * echarts option 由这里生成**普通对象**，组件只负责喂给 `setOption`——
 * 这样 option 的主题配色与数据形状都能在 Node 里单测，
 * 不需要起浏览器（红线 10 的可测形态：主题从 Token 传入，禁裸 hex）。
 *
 * 展示口径全部来自事实源：
 *  - 横幅文案：契约 `CompareResponse.banner` 逐字透传（`BL-2`）；
 *  - 徽章三段与方向箭头：`DESIGN.md` §4.1 `MetricDeltaBadge`；
 *  - 雷达双系列：`DESIGN.md` §5.1（基线 = `--chart-baseline`，当前 = `--primary`，
 *    面积填充 0.08 / 0.12，图例必备）；
 *  - 缺侧算子 `currentMean=null` 原样保留为 null —— 补 0 会把「没配算子」画成「0 分」。
 */
import type { CompareMetricRow, OperatorDiffRow } from '@eval-platform/contracts';
import { formatCost, formatDelta, formatScore } from '../format/index.js';
import type { ChartTheme } from '../charts/theme.js';

export type { ChartTheme } from '../charts/theme.js';

/** 已确认态的绿色氛围文案（页面级展示文案，flagged judgment：非契约原文）。 */
export const BANNER_CONFIRMED_TEXT = '对比基线为已确认基线';

export interface CompareBannerView {
  tone: 'pass' | 'warn';
  text: string;
}

/** 横幅三态：已确认 → pass 氛围；其余 → 契约 banner 原文逐字透传。 */
export function compareBannerView(baselineConfirmed: boolean, apiBanner: string | null): CompareBannerView {
  return baselineConfirmed
    ? { tone: 'pass', text: BANNER_CONFIRMED_TEXT }
    : { tone: 'warn', text: apiBanner ?? '' };
}

export type MetricDeltaView =
  | {
      kind: 'delta';
      variant: 'pass' | 'fail' | 'muted';
      arrow: '▲' | '▼' | null;
      deltaText: string;
      ariaLabel: string;
    }
  | { kind: 'text'; text: '无基线' | '不可比' };

/**
 * 变化列视图。**语义反转是本函数存在的理由**：
 * `higherIsBetter=false`（latency / cost）时 delta>0 是**退化**（fail），不是提升。
 * 方向箭头跟随原始 delta 方向（▲=数值上升），好/坏由 higherIsBetter 决定——
 * 颜色不是唯一编码：`formatDelta` 自带 +/− 符号与箭头（WCAG 1.4.1）。
 * baseline null → 无基线；current null → 不可比。均不渲染 0（`DESIGN.md` §4.1）。
 */
export function metricDeltaView(row: CompareMetricRow): MetricDeltaView {
  if (row.baseline === null) return { kind: 'text', text: '无基线' };
  if (row.current === null || row.delta === null) return { kind: 'text', text: '不可比' };
  const d = row.delta;
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : null;
  const good = d === 0 ? null : row.higherIsBetter ? d > 0 : d < 0;
  const variant = d === 0 ? 'muted' : good ? 'pass' : 'fail';
  const dirWord = d === 0 ? '持平' : d > 0 ? '上升' : '下降';
  const goodWord = d === 0 ? '' : good ? '，变好' : '，变差';
  const unit = row.metric.startsWith('latency') ? ' ms' : '';
  return {
    kind: 'delta',
    variant,
    arrow,
    deltaText: formatDelta(d),
    ariaLabel: `较基线${dirWord} ${String(Math.abs(d))}${unit}${goodWord}`,
  };
}

/** 指标值文本：分数走 4 位小数；延迟带单位；成本走既有成本格式化器；null → —。 */
export function metricValueText(metric: CompareMetricRow['metric'], v: number | null): string {
  if (v === null) return '—';
  if (metric.startsWith('latency')) return `${String(v)} ms`;
  if (metric === 'cost_total') return formatCost(v, 'total');
  return formatScore(v);
}

export interface OperatorTableRow {
  evaluatorKey: string;
  baselineText: string;
  currentText: string;
  deltaText: string;
  verdict: OperatorDiffRow['verdict'];
}

/** 图表红线 3 的表格孪生：雷达图里的每个数，这里都有可读文本（缺侧 = 不可比）。 */
export function operatorTableRows(operators: OperatorDiffRow[]): OperatorTableRow[] {
  return operators.map((o) => ({
    evaluatorKey: o.evaluatorKey,
    baselineText: o.baselineMean === null ? '不可比' : formatScore(o.baselineMean),
    currentText: o.currentMean === null ? '不可比' : formatScore(o.currentMean),
    deltaText: o.delta === null ? '不可比' : formatDelta(o.delta),
    verdict: o.verdict,
  }));
}

/**
 * 算子雷达 option（`DESIGN.md` §5.1）：双系列、基线 = `--chart-baseline`、
 * 当前 = `--primary`、面积填充 0.08 / 0.12、图例必备、无裸 hex。
 * 缺侧算子的值原样 `null` 交给 echarts（断点），不在数据层补 0。
 */
export function radarOption(operators: OperatorDiffRow[], theme: ChartTheme): Record<string, unknown> {
  return {
    legend: { data: ['基线', '当前'], bottom: 0, textStyle: { color: theme.text } },
    tooltip: {},
    radar: {
      indicator: operators.map((o) => ({ name: o.evaluatorKey })),
      radius: '62%',
      axisName: { color: theme.text, fontSize: 11 },
      splitLine: { lineStyle: { color: theme.grid } },
      axisLine: { lineStyle: { color: theme.axis } },
      splitArea: { show: false },
    },
    series: [
      {
        type: 'radar',
        name: '基线',
        data: [{ value: operators.map((o) => o.baselineMean), name: '基线' }],
        lineStyle: { color: theme.baseline, width: 2 },
        itemStyle: { color: theme.baseline },
        areaStyle: { color: theme.baseline, opacity: 0.08 },
        symbolSize: 8,
      },
      {
        type: 'radar',
        name: '当前',
        data: [{ value: operators.map((o) => o.currentMean), name: '当前' }],
        lineStyle: { color: theme.current, width: 2 },
        itemStyle: { color: theme.current },
        areaStyle: { color: theme.current, opacity: 0.12 },
        symbolSize: 8,
      },
    ],
  };
}
