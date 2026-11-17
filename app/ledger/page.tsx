'use client';

import * as React from 'react';
import type { Metadata } from 'next';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import * as echarts from 'echarts/core';
import { CostLedgerResponse } from '@eval-platform/contracts';
import type { CostLedgerDimension } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { rootChartTheme } from '@/lib/charts/theme';
import {
  LEDGER_DIMENSIONS,
  defaultLedgerRange,
  ledgerBarOption,
  ledgerDimensionLabel,
  ledgerSummaryCards,
} from '@/lib/ui/ledger';
import { useApi } from '@/lib/ui/use-api';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

export const metadata: Metadata = { title: '成本台账' };

/**
 * `PG-10` 成本台账大盘（M4 Batch 4，`US-019` 四维）。
 *
 * 结构：维度切换（时间/模型/评测集/发起人）→ 汇总卡 → **图表/表格孪生**（红线 3）
 * → 行内下钻链接（进运行台）。ECharts 主题从 Token 生成（红线 10）。
 */
export default function LedgerPage(): React.ReactElement {
  const [range] = React.useState(() => defaultLedgerRange());
  const [dimension, setDimension] = React.useState<CostLedgerDimension>('model');
  const [view, setView] = React.useState<'chart' | 'table'>('chart');

  const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&dimension=${dimension}`;
  const ledger = useApi(CostLedgerResponse, `/api/ledger?${query}`);
  const body = ledger.data;
  const rows = body?.items ?? [];
  const summary = body?.summary ?? null;

  const columns = React.useMemo<readonly DataTableColumn<(typeof rows)[number]>[]>(
    () => [
      { id: 'label', header: ledgerDimensionLabel(dimension), cell: (r) => <span className="font-medium text-foreground">{r.label}</span>, sortValue: (r) => r.label },
      { id: 'costTotal', header: '总成本 ¥', cell: (r) => r.costTotal.toFixed(4), sortValue: (r) => r.costTotal, align: 'end' },
      { id: 'costTarget', header: '被测 ¥', cell: (r) => r.costTarget.toFixed(4), sortValue: (r) => r.costTarget, align: 'end' },
      { id: 'costJudge', header: '裁判 ¥', cell: (r) => r.costJudge.toFixed(4), sortValue: (r) => r.costJudge, align: 'end' },
      { id: 'tokensIn', header: 'Token 入', cell: (r) => r.tokensIn.toLocaleString(), sortValue: (r) => r.tokensIn, align: 'end' },
      { id: 'tokensOut', header: 'Token 出', cell: (r) => r.tokensOut.toLocaleString(), sortValue: (r) => r.tokensOut, align: 'end' },
      { id: 'runCount', header: '运行', cell: (r) => r.runCount.toLocaleString(), sortValue: (r) => r.runCount, align: 'end' },
      { id: 'unknown', header: '成本未知', cell: (r) => (r.unknownCostCases > 0 ? `${r.unknownCostCases}` : '—'), sortValue: (r) => r.unknownCostCases, align: 'end' },
    ],
    [dimension],
  );

  return (
    <AppShellWithTheme breadcrumbs={[{ label: '管理' }, { label: '成本台账' }]}>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold text-foreground">成本台账</h1>
          <div className="ml-auto flex items-center gap-2">
            {LEDGER_DIMENSIONS.map((d) => (
              <Button
                key={d.value}
                size="sm"
                variant={dimension === d.value ? 'default' : 'ghost'}
                aria-pressed={dimension === d.value}
                onClick={() => setDimension(d.value)}
              >
                {d.label}
              </Button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <Button
              size="sm"
              variant={view === 'chart' ? 'default' : 'ghost'}
              aria-pressed={view === 'chart'}
              onClick={() => setView('chart')}
            >
              图表
            </Button>
            <Button
              size="sm"
              variant={view === 'table' ? 'default' : 'ghost'}
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
            >
              表格
            </Button>
          </div>
        </div>

        {summary === null ? (
          <p className="text-sm text-muted-foreground" role="status">
            {ledger.loading ? '加载中…' : (ledger.error?.message ?? '暂无数据')}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {ledgerSummaryCards(summary).map((c) => (
                <div key={c.label} className="rounded-md border border-border bg-card p-3">
                  <div className="text-xs text-muted-foreground">{c.label}</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{c.value}</div>
                  {c.hint !== undefined ? <div className="mt-1 text-xs text-muted-foreground">{c.hint}</div> : null}
                </div>
              ))}
            </div>

            {view === 'chart' ? (
              <LedgerBar rows={rows} ariaLabel={`按${ledgerDimensionLabel(dimension)}分组的成本柱状图`} />
            ) : rows.length > 0 ? (
              <DataTable rows={rows} columns={columns} getRowId={(r) => r.dimensionKey} />
            ) : (
              <p className="text-sm text-muted-foreground" role="status">
                该维度在本时间窗内没有运行记录。
              </p>
            )}
          </>
        )}
      </div>
    </AppShellWithTheme>
  );
}

/** 图表容器（与 OperatorRadar 同构：init → setOption → resize → dispose）。 */
function LedgerBar({ rows, ariaLabel }: { rows: { label: string; costTotal: number }[]; ariaLabel: string }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const option = React.useMemo(() => ledgerBarOption(rows, rootChartTheme()), [rows]);

  React.useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(option as Parameters<typeof chart.setOption>[0]);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className="h-[360px] w-full" />;
}
