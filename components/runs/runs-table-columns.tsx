'use client';

import * as React from 'react';
import Link from 'next/link';
import type { EvalRun } from '@eval-platform/contracts';
import type { DataTableColumn } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { GateBadge } from '@/components/runs/gate-badge';
import { formatTimestamp } from '@/lib/format';
import { runCostLabel, runDurationLabel, runScoreLabel } from '@/lib/ui/runs';

/**
 * `PG-01` 列表列定义（`SPEC-M1` `[FE-03]` 交付物 1）。
 *
 * ## 为什么从页面里抽出来
 *
 * 列定义是**产品口径**，不是布局：列序、列名、哪一列是数字列、门禁列显示什么，
 * 每一条都对应 SPEC 的一行原文。写在页面组件的 `useMemo` 里，就只能靠人眼验收；
 * 抽成模块后可以被 `tests/runs-render-parity.spec.ts` 用**真实 `<DataTable>` 渲染**
 * 后逐字断言 —— 包括「有人按状态推出准出」这种最危险、也最不容易被发现的走样。
 *
 * ## 列序
 *
 * `评测名称 ｜ 状态 ｜ 综合得分 ｜ 耗时 ｜ Token 成本 ｜ 发起人 ｜ 发起时间 ｜ 准出门禁 ｜ 操作`
 *
 * 前八列的顺序逐字取自 `[FE-03]` 交付物 1；「准出门禁」插在「发起时间」之后、
 * 「操作」之前，位于行尾操作区之前（`SPEC-M1` §6.5 `T-2` 裁定该列必须存在且可见）。
 *
 * 页面**不在**列表里放裸「Token」列：交付物清单里只有「Token 成本」，
 * 多一列就是偏离；Token 总数在 `PG-03` 详情页的指标卡里。
 */
export const runsTableColumns: readonly DataTableColumn<EvalRun>[] = [
  {
    id: 'name',
    header: '评测名称',
    /**
     * `max-w-[22rem]` 不能省：表格是 `table-layout: auto`，单元格宽度由内容撑开，
     * 里面的 `.truncate` 没有宽度上限就永远不会出现省略号，反而把整行顶出横向滚动
     * （1440px 视口实测：1189px 表格挤进 1172px 容器，最后一列「操作」被切掉）。
     * 给名称列一个上限，两条 `truncate` 才真的截断，其余列自然回到内容宽度。
     * 两个 `title` 是 `DESIGN.md` §6.1「超长文本：单行 truncate + title 全文」的要求。
     */
    cell: (r) => (
      <div className="min-w-0 max-w-[22rem]">
        <div className="truncate font-medium text-foreground" title={r.name}>
          {r.name}
        </div>
        <div
          className="truncate text-2xs text-muted-foreground"
          title={`${r.datasetLabel} · ${r.targetLabel}`}
        >
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
    /**
     * 准出门禁：M1 恒为「未评估」（`SPEC-M1` §6.5 `T-2`）。
     *
     * **不接受行数据、不给 `sortValue`**：
     *  - 不接受行数据 —— 一旦这里能读到 `r.status` / `r.metrics`，
     *    「顺手推一个准出」的门就开了，而 `gate_evaluations` 在 M1 是空表，
     *    任何推导出来的裁决都是编的；
     *  - 不给 `sortValue` —— 整列同值，排序点了不会有反应，可点而无反应比不可点更糟。
     */
    id: 'gate',
    header: '准出门禁',
    cell: () => <GateBadge />,
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
];
