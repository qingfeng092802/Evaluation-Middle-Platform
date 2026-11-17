/**
 * ECharts 主题（`DESIGN.md` §5.2 红线 10）：**主题必须从 Token 生成一次**，
 * 图表 option 里禁止裸 `#hex`（`technical-solution.md` TS-5 点名的短板）。
 *
 * 读取方式：`rootChartTheme()` 在客户端从 `documentElement` 的计算样式取
 * CSS 自定义属性——深浅色模式切换时 Token 自动换值，图表跟着主题走。
 * 纯函数 `chartThemeFromTokens(getVar)` 是可测形态（Node 里传假 getVar）。
 */
export interface ChartTheme {
  /** 基线系列（`--chart-baseline`：语义是「退后参照物」，不用分类槽）。 */
  baseline: string;
  /** 当前系列（`--primary`）。 */
  current: string;
  grid: string;
  axis: string;
  text: string;
}

const CHART_TOKEN_NAMES = {
  baseline: '--chart-baseline',
  current: '--primary',
  grid: '--chart-grid',
  axis: '--chart-axis',
  text: '--foreground',
} as const;

export function chartThemeFromTokens(getVar: (name: string) => string): ChartTheme {
  return {
    baseline: getVar(CHART_TOKEN_NAMES.baseline),
    current: getVar(CHART_TOKEN_NAMES.current),
    grid: getVar(CHART_TOKEN_NAMES.grid),
    axis: getVar(CHART_TOKEN_NAMES.axis),
    text: getVar(CHART_TOKEN_NAMES.text),
  };
}

export function rootChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  return chartThemeFromTokens((name) => cs.getPropertyValue(name).trim());
}
