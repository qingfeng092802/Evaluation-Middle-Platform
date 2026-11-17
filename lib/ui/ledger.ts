/**
 * PG-10 成本台账的展示派生（M4 Batch 4）。
 *
 * 这里只做「契约数据 → 展示形状」的纯转换；请求/状态在页面组件里。
 * 图表 option 由纯函数生成、主题走 `ChartTheme`（红线 10：禁裸 hex），
 * 表格孪生由调用方「图表 / 表格」切换提供（红线 3）。
 */
import type { CostLedgerDimension, CostLedgerSummary } from '@eval-platform/contracts';
import type { ChartTheme } from '../charts/theme.js';

export const LEDGER_DIMENSIONS: readonly { readonly value: CostLedgerDimension; readonly label: string }[] = [
  { value: 'time', label: '时间' },
  { value: 'model', label: '模型' },
  { value: 'dataset', label: '评测集' },
  { value: 'user', label: '发起人' },
];

export function ledgerDimensionLabel(d: CostLedgerDimension): string {
  return LEDGER_DIMENSIONS.find((x) => x.value === d)?.label ?? d;
}

/** 本月窗口（[月初 00:00, 现在]）的 ISO 串，页面默认查询参数。 */
export function defaultLedgerRange(now: Date = new Date()): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: from.toISOString(), to: now.toISOString() };
}

/** 金额显示：保留 4 位小数（numeric(18,8) 原样太长，台账是「对账」不是「计价」）。 */
export function ledgerMoney(v: number): string {
  return v.toFixed(4);
}

/** 汇总卡：六个数字 + unknown 提示语（unknownCostCases>0 时必须露出，US-021）。 */
export function ledgerSummaryCards(
  summary: CostLedgerSummary,
): readonly { readonly label: string; readonly value: string; readonly hint?: string }[] {
  const cards = [
    { label: '总成本', value: `¥${ledgerMoney(summary.costTotal)}`, hint: `目标 ¥${ledgerMoney(summary.costTarget)} + 裁判 ¥${ledgerMoney(summary.costJudge)}` },
    { label: '被测成本', value: `¥${ledgerMoney(summary.costTarget)}` },
    { label: '裁判成本', value: `¥${ledgerMoney(summary.costJudge)}` },
    { label: 'Token 输入', value: summary.tokensIn.toLocaleString() },
    { label: 'Token 输出', value: summary.tokensOut.toLocaleString() },
    { label: '运行数', value: summary.runCount.toLocaleString() },
  ];
  if (summary.unknownCostCases > 0) {
    return [
      ...cards,
      {
        label: '成本未知',
        value: `${summary.unknownCostCases.toLocaleString()} 条`,
        hint: 'T2 端点未回传 usage——成本按 0 计入但语义是未知（US-021），不得当作真实零成本',
      },
    ];
  }
  return cards;
}

/**
 * 维度柱状图 option（系列色 = `--primary`，网格/轴/文字走 Token）。
 * 单系列横向柱：按 costTotal 降序的 rows 已由服务端排好。
 * 只取 `label` / `costTotal` 两列，调用方可传任意行形状（孪生表格用全量字段）。
 */
export function ledgerBarOption(
  rows: readonly { readonly label: string; readonly costTotal: number }[],
  theme: ChartTheme,
): Record<string, unknown> {
  const top = rows.slice(0, 12);
  return {
    grid: { left: 8, right: 16, top: 8, bottom: 0, containLabel: true },
    tooltip: { trigger: 'item', textStyle: { color: theme.text } },
    xAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: theme.axis } },
      splitLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.text },
    },
    yAxis: {
      type: 'category',
      data: top.map((r) => r.label),
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.text, width: 160, overflow: 'truncate' },
    },
    series: [
      {
        name: '成本（¥）',
        type: 'bar',
        data: top.map((r) => r.costTotal),
        itemStyle: { color: theme.current },
        barMaxWidth: 18,
      },
    ],
  };
}
