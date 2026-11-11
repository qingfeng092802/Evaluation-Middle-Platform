'use client';

import * as React from 'react';
import type { Dataset } from '@eval-platform/contracts';
import type { DataTableColumn } from '@/components/ui/data-table';
import { formatTimestamp } from '@/lib/format';
import { caseCountCell, datasetSourceLabel, versionCell } from '@/lib/ui/datasets';

/**
 * `PG-05` 列表列定义（`SPEC-M1` `[FE-02]` 交付物 1）。
 *
 * ## 列序（原文，逐字）
 *
 * `名称 ｜ 最新版本 ｜ 条目数 ｜ 来源 ｜ 最近更新 ｜ 操作`
 *
 * **恰好 6 列**：`[FE-02]` 交付物 1 与 `pages-and-flows.md` 区域 2 的清单逐字相同，
 * 不多不少。原型（`ui-reference.html`）用的是卡片网格，不是表格 —— 本项目按 SPEC
 * 做成 6 列表格，这是需求方 2026-11-11 第 5 批的明确约束：
 * 「按 SPEC-M1 [FE-02] 的 6 列表格，不按原型的卡片网格」。
 *
 * ## 数字列
 *
 * `最新版本`（`v3`）、`条目数`（`50`）、`最近更新`（`2026-11-11 12:37:09`）三列声明
 * `numeric: true` ⇒ 右对齐 + `.num`（`tabular-nums`）。版本号虽然带 `v` 前缀，
 * 但它是数字列（`v1`…`v12` 位数会变），必须等宽否则右对齐会跳。
 *
 * ## 为什么从页面里抽出来
 *
 * 与 `components/runs/runs-table-columns.tsx` 同一个理由：列序、列名、哪一列是
 * 数字列，每一条都对应事实文档的一行原文。写在页面的 `useMemo` 里只能靠人眼验收；
 * 抽成模块后可以被 `tests/datasets-render-parity.spec.ts` 用**真实 `<DataTable>`
 * 渲染**后逐字断言。
 *
 * ## 为什么是工厂函数而不是常量
 *
 * 「操作」列的 `aria-expanded` 必须与页面真实的展开状态一致，否则读屏用户听到
 * 「已折叠」而眼睛看到展开。展开状态是页面 state，只能由调用方传进来。
 * 用工厂函数（而不是 Context）把依赖显式化：签名上就能看出这一列依赖外部状态。
 */

/** 页面需要提供给列定义的交互回调。 */
export interface DatasetsTableOptions {
  /** 当前展开版本历史的评测集 id；`null` = 都收起。 */
  readonly expandedId: string | null;
  /** 切换某个评测集的展开状态。 */
  readonly onToggle: (datasetId: string) => void;
}

export function datasetsTableColumns(
  options: DatasetsTableOptions = { expandedId: null, onToggle: () => undefined },
): readonly DataTableColumn<Dataset>[] {
  const { expandedId, onToggle } = options;

  return [
    {
      id: 'name',
      header: '名称',
      /**
       * `max-w-[22rem]` 不能省（与 `/runs` 的名称列同因）：表格是 `table-layout: auto`，
       * 单元格宽度由内容撑开，`.truncate` 没有宽度上限就永远不省略号，
       * 反而把整行顶出横向滚动。两个 `title` 满足「超长文本单行 truncate + title 全文」。
       */
      cell: (d) => (
        <div className="min-w-0 max-w-[22rem]">
          <div className="truncate font-medium text-foreground" title={d.name}>
            {d.name}
          </div>
          {d.description === null ? null : (
            <div className="truncate text-2xs text-muted-foreground" title={d.description}>
              {d.description}
            </div>
          )}
        </div>
      ),
      sortValue: (d) => d.name,
    },
    {
      id: 'latestVersion',
      header: '最新版本',
      numeric: true,
      cell: (d) => versionCell(d.latestVersionNo),
      sortValue: (d) => d.latestVersionNo,
    },
    {
      id: 'caseCount',
      header: '条目数',
      numeric: true,
      cell: (d) => caseCountCell(d.caseCount),
      sortValue: (d) => d.caseCount,
    },
    {
      id: 'source',
      header: '来源',
      // 来源存在版本上，接口已聚合为 `latestSource`；无版本时为 null ⇒ `—`。
      cell: (d) => datasetSourceLabel(d.latestSource),
      sortValue: (d) => d.latestSource,
    },
    {
      id: 'updatedAt',
      header: '最近更新',
      numeric: true,
      cell: (d) => <span className="num-mono">{formatTimestamp(d.updatedAt)}</span>,
      sortValue: (d) => d.updatedAt,
    },
    {
      id: 'actions',
      header: '操作',
      /**
       * 行操作**只有「查看版本」**（`pages-and-flows.md` `PG-05` 区域 2 原文）。
       *
       * `pages-and-flows.md` 明确不做「删除版本」（违反 `PT-2`）与「导出 JSONL」
       * （无故事支撑）—— 所以这里没有那两颗按钮，不是忘了加。
       */
      cell: (d) => (
        <button
          type="button"
          className="text-primary underline-offset-4 hover:underline"
          aria-expanded={expandedId === d.id}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(d.id);
          }}
        >
          查看版本
        </button>
      ),
      srOnlyHeader: '（展开该评测集的版本历史）',
    },
  ];
}
