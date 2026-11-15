'use client';

import * as React from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { RunComparisonDiffResponse } from '@eval-platform/contracts';
import type { EvalRun } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { CompareBanner } from '@/components/compare/compare-banner';
import { MetricDeltaBadge } from '@/components/ui/metric-delta-badge';
import { OperatorRadar } from '@/components/charts/operator-radar';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import type { DataTableColumn } from '@/components/ui/data-table';
import { useApi } from '@/lib/ui/use-api';
import {
  compareBannerView,
  metricDeltaView,
  metricValueText,
  operatorTableRows,
  radarOption,
} from '@/lib/ui/compare';
import { rootChartTheme } from '@/lib/charts/theme';
import { formatDelta, formatScore } from '@/lib/format';
import { runScoreLabel } from '@/lib/ui/runs';

/**
 * `PG-08` · 报告对比（`US-009` / `US-010` 数据面；`SPEC-M3` Batch 3）。
 *
 * 入口：`/runs` 勾选恰好 2 行 → 「对比所选」→ `?baseline=<id>&current=<id>`。
 * 数据源**唯一**：`GET /api/compare/diff`（`RunComparisonDiffResponse` 是
 * `CompareResponse` 的契约级扩展，一次取齐 metrics / cases / operators / summary）。
 *
 * 三态横幅（`BL-2`）：已确认基线 → 绿色氛围；否则契约 banner 原文逐字透传。
 * 硬拒绝（版本不同 / 同 run 自比）由后端 400 返回，`error.message` 即
 * `describeIncomparable()` 原文——本页原样展示，不改写。
 */
const BREADCRUMBS = [{ label: '评测运行', href: '/runs' }, { label: '报告对比' }];

function CompareContent(): React.ReactElement {
  const sp = useSearchParams();
  const baseline = sp.get('baseline');
  const current = sp.get('current');
  const ready = baseline !== null && current !== null && baseline !== '' && current !== '';
  const diff = useApi(
    RunComparisonDiffResponse,
    ready ? `/api/compare/diff?baselineRunId=${String(baseline)}&currentRunId=${String(current)}` : null,
  );
  const [operatorView, setOperatorView] = React.useState<'chart' | 'table'>('chart');
  const data = diff.data;

  if (!ready) {
    return (
      <div className="rounded-sm border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        从评测运行台勾选恰好两次运行，点「对比所选」开始对比。
        <Link href="/runs" className="ml-1 text-foreground underline underline-offset-2">
          去评测运行台
        </Link>
      </div>
    );
  }

  // 有数据先渲染（refreshing 时保留上一帧降透明，不闪骨架——DESIGN §6.1）
  if (data !== null) {
    return (
      <ComparePageBody
        data={data}
        operatorView={operatorView}
        setOperatorView={setOperatorView}
        refreshing={diff.refreshing}
      />
    );
  }

  if (diff.error !== null) {
    // 硬拒绝（400）时 message = describeIncomparable() 原文；404 = 运行不存在。原样展示，不改写。
    return (
      <div className="flex flex-col gap-4">
        <CompareBanner tone="warn" text={diff.error.message} />
        <div className="text-xs text-muted-foreground">
          <Link href="/runs" className="text-foreground underline underline-offset-2">
            返回评测运行台
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
      正在加载对比数据…
    </div>
  );
}

function ComparePageBody({
  data,
  operatorView,
  setOperatorView,
  refreshing,
}: {
  data: RunComparisonDiffResponse;
  operatorView: 'chart' | 'table';
  setOperatorView: (v: 'chart' | 'table') => void;
  refreshing: boolean;
}): React.ReactElement {
  const banner = compareBannerView(data.baselineConfirmed, data.banner);
  const theme = React.useMemo(() => rootChartTheme(), []);
  const radarOptionMemo = React.useMemo(() => radarOption(data.operators, theme), [data.operators, theme]);
  const opRows = React.useMemo(() => operatorTableRows(data.operators), [data.operators]);

  const summary = [
    { label: '可对齐 Case', value: data.summary.comparableCases },
    { label: '退化', value: data.summary.regressedCases },
    { label: '改善', value: data.summary.improvedCases },
    { label: '持平', value: data.summary.unchangedCases },
    { label: '不可比', value: data.summary.notComparableCases },
    { label: '总 Case', value: data.summary.totalCases },
  ];

  return (
    <div aria-busy={refreshing} className="flex flex-col gap-4">
      <CompareBanner tone={banner.tone} text={banner.text} />

      {/* 两个 run 的身份行（名称 / 状态 / 综合得分），数据来自契约 EvalRun */}
      <div className="grid grid-cols-2 gap-3">
        <RunIdentityCard role="基线" run={data.baselineRun} />
        <RunIdentityCard role="当前" run={data.currentRun} />
      </div>

      {/* 对齐摘要（DiffSummary 契约：前端统计卡直接取数，不自行遍历） */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {summary.map((s) => (
          <span key={s.label} className="num">
            {s.label} <span className="font-medium text-foreground">{s.value}</span>
          </span>
        ))}
      </div>

      {/* 汇总对比表：指标 ｜ 基线 ｜ 当前 ｜ 变化（变化列走 MetricDeltaBadge，含 higherIsBetter 反转） */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">汇总对比</h2>
        <DataTable columns={metricColumns} rows={data.metrics} getRowId={(m) => m.metric} refreshing={refreshing} />
      </section>

      {/* 算子对比：图表 / 表格切换（`DESIGN.md` §5.2 红线 3） */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium text-muted-foreground">算子对比</h2>
          <div className="flex items-center gap-1" role="group" aria-label="算子对比视图切换">
            <Button variant={operatorView === 'chart' ? 'default' : 'outline'} size="sm" onClick={() => setOperatorView('chart')}>
              图表
            </Button>
            <Button variant={operatorView === 'table' ? 'default' : 'outline'} size="sm" onClick={() => setOperatorView('table')}>
              表格
            </Button>
          </div>
        </div>
        {operatorView === 'chart' ? (
          <OperatorRadar option={radarOptionMemo} ariaLabel="算子得分雷达图：基线与当前两系列；数值见表格视图" />
        ) : (
          <OperatorTable rows={opRows} />
        )}
      </section>

      {/* 逐条对比表（PG-08 区域 3）：case_key ｜ 基线得分 ｜ 当前得分 ｜ 变化 ｜ 查看 Diff */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">逐条对比</h2>
        <DataTable
          columns={caseColumns}
          rows={data.cases}
          getRowId={(c) => c.caseKey}
          refreshing={refreshing}
        />
      </section>
    </div>
  );
}

function RunIdentityCard({ role, run }: { role: string; run: EvalRun }): React.ReactElement {
  return (
    <div className="rounded-sm border border-border bg-card px-3 py-2">
      <div className="text-2xs text-muted-foreground">{role}</div>
      <div className="truncate text-xs font-medium text-foreground" title={run.name}>
        {run.name}
      </div>
      <div className="num text-2xs text-muted-foreground">综合得分 {runScoreLabel(run)}</div>
    </div>
  );
}

/** 汇总对比列：`指标 ｜ 基线 ｜ 当前 ｜ 变化`（`pages-and-flows.md` PG-08 区域 2）。 */
const metricColumns: readonly DataTableColumn<RunComparisonDiffResponse['metrics'][number]>[] = [
  { id: 'metric', header: '指标', cell: (m) => <span className="text-xs">{m.label}</span> },
  {
    id: 'baseline',
    header: '基线',
    numeric: true,
    cell: (m) => <span className="num">{metricValueText(m.metric, m.baseline)}</span>,
    sortValue: (m) => m.baseline ?? -1,
  },
  {
    id: 'current',
    header: '当前',
    numeric: true,
    cell: (m) => <span className="num">{metricValueText(m.metric, m.current)}</span>,
    sortValue: (m) => m.current ?? -1,
  },
  {
    id: 'delta',
    header: '变化',
    cell: (m) => <MetricDeltaBadge view={metricDeltaView(m)} />,
  },
];

/** 算子对比表格视图（雷达的孪生，红线 3）。 */
function OperatorTable({ rows }: { rows: ReturnType<typeof operatorTableRows> }): React.ReactElement {
  const columns: readonly DataTableColumn<ReturnType<typeof operatorTableRows>[number]>[] = [
    { id: 'key', header: '算子', cell: (r) => <span className="text-xs">{r.evaluatorKey}</span> },
    { id: 'baseline', header: '基线', numeric: true, cell: (r) => <span className="num">{r.baselineText}</span> },
    { id: 'current', header: '当前', numeric: true, cell: (r) => <span className="num">{r.currentText}</span> },
    { id: 'delta', header: '变化', numeric: true, cell: (r) => <span className="num">{r.deltaText}</span> },
    { id: 'verdict', header: '判定', cell: (r) => <span className="text-xs">{r.verdict}</span> },
  ];
  return <DataTable columns={columns} rows={rows} getRowId={(r) => r.evaluatorKey} />;
}

/** 逐条对比列（`pages-and-flows.md` PG-08 区域 3 逐字；「查看 Diff」按钮指向 Batch 4 的 PG-04）。 */
const caseColumns: readonly DataTableColumn<RunComparisonDiffResponse['cases'][number]>[] = [
  { id: 'caseKey', header: 'case_key', cell: (c) => <span className="num text-xs">{c.caseKey}</span> },
  {
    id: 'baselineScore',
    header: '基线得分',
    numeric: true,
    cell: (c) => <span className="num">{c.baselineScore === null ? '不可比' : formatScore(c.baselineScore)}</span>,
    sortValue: (c) => c.baselineScore ?? -1,
  },
  {
    id: 'currentScore',
    header: '当前得分',
    numeric: true,
    cell: (c) => <span className="num">{c.currentScore === null ? '不可比' : formatScore(c.currentScore)}</span>,
    sortValue: (c) => c.currentScore ?? -1,
  },
  {
    id: 'delta',
    header: '变化',
    cell: (c) => <span className="num">{c.delta === null ? '不可比' : formatDelta(c.delta)}</span>,
  },
  {
    id: 'openDiff',
    header: '操作',
    cell: () => (
      <Button variant="outline" size="sm" disabled title="PG-04 双栏 Diff 属 Batch 4 交付，本批未实现">
        查看 Diff
      </Button>
    ),
  },
];

export default function RunsComparePage(): React.ReactElement {
  return (
    <AppShellWithTheme breadcrumbs={BREADCRUMBS}>
      <Suspense fallback={null}>
        <CompareContent />
      </Suspense>
    </AppShellWithTheme>
  );
}
