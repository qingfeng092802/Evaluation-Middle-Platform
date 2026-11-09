'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { EvalRunListResponse } from '@eval-platform/contracts';
import type { EvalRun } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { useApi } from '@/lib/ui/use-api';
import { formatTimestamp, formatTokens } from '@/lib/format';
import {
  runCostLabel,
  runDurationLabel,
  runScoreLabel,
} from '@/lib/ui/runs';
import { ProviderBanner } from '@/components/shell/provider-banner';

/**
 * `PG-01` · 评测运行台。
 *
 * 列表列严格按 `pages-and-flows.md` PG-01 区域 3：
 * `评测名称 ｜ 状态 ｜ 综合得分 ｜ 耗时 ｜ Token 成本 ｜ 发起人 ｜ 发起时间 ｜ 操作`。
 *
 * 所有数字列声明 `numeric: true` ⇒ 右对齐 + `.num`（`DESIGN.md` §3.2），
 * 不靠调用方逐个记着写类名。
 */
export default function RunsPage(): React.ReactElement {
  const runs = useApi(EvalRunListResponse, '/api/runs?limit=50');

  const columns = React.useMemo<readonly DataTableColumn<RunRow>[]>(
    () => [
      {
        id: 'name',
        header: '评测名称',
        cell: (r) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{r.name}</div>
            <div className="truncate text-2xs text-muted-foreground">
              {r.datasetLabel} · {r.targetLabel}
            </div>
          </div>
        ),
        sortValue: (r) => r.name,
      },
      {
        id: 'status',
        header: '状态',
        cell: (r) => <StatusBadge status={r.status} />,
        sortValue: (r) => r.status,
      },
      {
        id: 'score',
        header: '综合得分',
        numeric: true,
        cell: (r) => runScoreLabel(r),
        sortValue: (r) => r.metrics.scoreOverall,
      },
      {
        id: 'duration',
        header: '耗时',
        numeric: true,
        cell: (r) => runDurationLabel(r),
        sortValue: (r) =>
          r.startedAt === null || r.finishedAt === null
            ? null
            : Date.parse(r.finishedAt) - Date.parse(r.startedAt),
      },
      {
        id: 'tokens',
        header: 'Token',
        numeric: true,
        cell: (r) => formatTokens(r.metrics.tokensInTotal + r.metrics.tokensOutTotal),
        sortValue: (r) => r.metrics.tokensInTotal + r.metrics.tokensOutTotal,
      },
      {
        id: 'cost',
        header: 'Token 成本',
        numeric: true,
        cell: (r) => runCostLabel(r),
        sortValue: (r) => r.metrics.costTotal,
      },
      {
        id: 'createdBy',
        header: '发起人',
        cell: (r) => <span className="text-body">{r.createdBy}</span>,
        sortValue: (r) => r.createdBy,
      },
      {
        id: 'createdAt',
        header: '发起时间',
        numeric: true,
        cell: (r) => <span className="num-mono">{formatTimestamp(r.createdAt)}</span>,
        sortValue: (r) => r.createdAt,
      },
      {
        id: 'actions',
        header: '操作',
        cell: (r) => (
          <Link
            href={`/runs/${r.id}`}
            className="text-primary underline-offset-4 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            查看报告
          </Link>
        ),
        srOnlyHeader: '（打开该次运行的报告）',
      },
    ],
    [],
  );

  return (
    <AppShellWithTheme
      breadcrumbs={[{ label: '评测运行', href: '/runs' }]}
      actions={
        <Button asChild size="sm">
          <Link href="/runs/new">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> 发起评测
          </Link>
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <h1 className="text-base font-semibold text-foreground">评测运行</h1>

        <ProviderBanner />

        {runs.error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            加载失败：{runs.error.message}
          </div>
        ) : null}

        <DataTable<RunRow>
          columns={columns}
          rows={runs.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={runs.loading}
          refreshing={runs.refreshing}
          emptyKey="runs"
          rowAriaLabel={(r) => `${r.name}，状态${r.status}`}
        />
      </div>
    </AppShellWithTheme>
  );
}

/** 行类型即契约里的 `EvalRun`（`EvalRunListResponse.items` 的元素）。 */
type RunRow = EvalRun;
