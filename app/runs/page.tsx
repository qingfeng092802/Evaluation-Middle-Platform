'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GitCompareArrows, Plus } from 'lucide-react';
import { EvalRunListResponse } from '@eval-platform/contracts';
import type { EvalRun } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import type { DataTableColumn } from '@/components/ui/data-table';
import { runsTableColumns } from '@/components/runs/runs-table-columns';
import { useApi } from '@/lib/ui/use-api';
import { ProviderBanner } from '@/components/shell/provider-banner';

/**
 * `PG-01` · 评测运行台。
 *
 * 三块内容，对应 `SPEC-M1` `[FE-03]` 交付物 1：
 *  1. **前置横幅** `<ProviderBanner />` —— 只在未配凭证时出现（M1 种子自带
 *     `is_active=true` 的 fixture provider，正常演示不显示）；
 *  2. **列表** —— 列定义在 `components/runs/runs-table-columns.tsx`，
 *     那里逐列对着 SPEC 原文，并被渲染级测试锁死；
 *  3. **空状态** —— 由 `DataTable` 的 `emptyKey="runs"` 提供，文案与出口取自
 *     `pages-and-flows.md` §5 原文。
 *
 * **M1 不加 KPI 行**（`SPEC-M1` §6.5 `T-1`，2026-11-10 裁定）：
 * 门禁通过率等指标依赖 `gate_evaluations`，该表此刻为空，凭空造数就是假数据。
 *
 * **M3 新增**：行首勾选列 + 「对比所选」（`pages-and-flows.md` PG-01 批量操作，
 * `US-009`）：勾选恰好 2 行后可跳转 `PG-08`。先勾的是基线，后勾的是当前
 * ——顺序写进 URL（`?baseline=&current=`），由选择顺序而非时间戳决定。
 * 选择列在**页面层**组装（`runsTableColumns` 模块常量保持 parity 锁定的原样）。
 */
export default function RunsPage(): React.ReactElement {
  const runs = useApi(EvalRunListResponse, '/api/runs?limit=50');
  const router = useRouter();
  const [selected, setSelected] = React.useState<string[]>([]);

  const toggleSelect = React.useCallback((id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const columns = React.useMemo<readonly DataTableColumn<EvalRun>[]>(() => {
    const selectColumn: DataTableColumn<EvalRun> = {
      id: 'select',
      header: '',
      srOnlyHeader: '（勾选两次运行后可对比）',
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={`选择 ${r.name} 参与对比`}
          checked={selected.includes(r.id)}
          onChange={() => toggleSelect(r.id)}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 accent-primary"
        />
      ),
    };
    return [selectColumn, ...runsTableColumns];
  }, [selected, toggleSelect]);

  return (
    <AppShellWithTheme
      breadcrumbs={[{ label: '评测运行', href: '/runs' }]}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={selected.length !== 2}
            title="勾选恰好两次运行后可用（先勾的为基线，后勾的为当前）"
            onClick={() => {
              if (selected.length === 2) {
                router.push(`/runs/compare?baseline=${selected[0]}&current=${selected[1]}`);
              }
            }}
          >
            <GitCompareArrows className="h-3.5 w-3.5" aria-hidden="true" /> 对比所选
          </Button>
          <Button asChild size="sm">
            <Link href="/runs/new">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> 发起评测
            </Link>
          </Button>
        </>
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

        <DataTable<EvalRun>
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
