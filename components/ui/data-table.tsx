'use client';

import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from './table';
import { TableSkeleton } from './skeleton';
import { EmptyState, type EmptyStateKey } from '@/components/shell/empty-state';

/**
 * 表格列定义。
 *
 * `numeric` 一列的意义：数字列**必须**右对齐 + `.num`（`DESIGN.md` §3.2 / §3.3）。
 * 让调用方逐个 `className="text-right num"` 记着写，迟早会漏；声明成列属性后
 * DataTable 统一施加，漏不掉。
 */
export interface DataTableColumn<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => React.ReactNode;
  /** 数字列：右对齐 + `.num` + 固定宽度防抖动。 */
  readonly numeric?: boolean;
  /** 供屏幕阅读器与排序按钮用的额外说明。 */
  readonly srOnlyHeader?: string;
  /**
   * 可排序列的**取值函数**。
   *
   * 单独给而不是让 TanStack 猜：`cell` 返回的是 JSX，无法参与比较。
   * 缺省时该列不可排序 —— 「能点但点了没反应」比「不能点」更糟。
   */
  readonly sortValue?: (row: T) => string | number | null;
}

interface DataTableProps<T> {
  readonly columns: readonly DataTableColumn<T>[];
  readonly rows: readonly T[];
  readonly getRowId: (row: T) => string;
  /** 加载中：渲染与真实列宽一致的骨架，**不**用 spinner（`DESIGN.md` §6.1）。 */
  readonly loading?: boolean;
  /** refetch 中：保留上一帧、降透明度，不闪骨架。 */
  readonly refreshing?: boolean;
  readonly emptyKey?: EmptyStateKey;
  readonly onRowClick?: (row: T) => void;
  readonly rowAriaLabel?: (row: T) => string;
  readonly className?: string;
}

/**
 * 数据表（TanStack Table `^8`，渲染真实 `<table>`）。
 *
 * 三态齐备（`AS-3`）：
 *  - `loading` ⇒ `TableSkeleton`（形状与真实行一致）；
 *  - `rows` 为空 ⇒ `EmptyState`（文案取自 `pages-and-flows.md` §5 原文）；
 *  - `refreshing` ⇒ 保留上一帧 + `opacity-60`，避免骨架闪烁。
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  loading = false,
  refreshing = false,
  emptyKey,
  onRowClick,
  rowAriaLabel,
  className,
}: DataTableProps<T>): React.ReactElement {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  // TanStack 需要 ColumnDef 的 accessorFn 才能排序；这里用「按 id 取值」的方式接入，
  // 保持我们的单元格渲染函数（`cell`）与 TanStack 的渲染职责分离。
  const columnDefs = React.useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((c) => ({
        id: c.id,
        header: c.header,
        // 有 sortValue 才排序；`null` 排在最后（与接口的 NULLS LAST 口径一致）
        accessorFn: c.sortValue === undefined ? () => undefined : (row: T) => c.sortValue?.(row) ?? null,
        enableSorting: c.sortValue !== undefined,
        meta: { numeric: c.numeric === true },
        cell: ({ row }) => c.cell(row.original),
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows as T[],
    columns: columnDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => getRowId(row),
  });

  if (loading) return <TableSkeleton cols={columns.length} rows={5} />;

  if (rows.length === 0 && emptyKey !== undefined) {
    return <EmptyState stateKey={emptyKey} />;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)} aria-busy={refreshing}>
      <Table>
        <TableHead>
          <TableRow className="hover:bg-transparent">
            {table.getHeaderGroups()[0]?.headers.map((header, i) => {
              const col = columns[i];
              const numeric = col?.numeric === true;
              const sortable = col?.sortValue !== undefined;
              const sorted = header.column.getIsSorted();
              return (
                <TableHeaderCell
                  key={header.id}
                  className={cn(numeric && 'text-right num')}
                  aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-sm',
                        'hover:text-foreground focus-visible:text-foreground',
                        numeric && 'w-full justify-end',
                      )}
                    >
                      <span>{col?.header}</span>
                      {sorted === 'asc' ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
                      )}
                      <span className="sr-only">，点击切换排序</span>
                    </button>
                  ) : (
                    col?.header
                  )}
                  {col?.srOnlyHeader !== undefined ? (
                    <span className="sr-only">{col.srOnlyHeader}</span>
                  ) : null}
                </TableHeaderCell>
              );
            })}
          </TableRow>
        </TableHead>
        <TableBody className={cn(refreshing && 'opacity-60 transition-opacity duration-150')}>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn(onRowClick !== undefined && 'cursor-pointer hover:bg-muted')}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              aria-label={rowAriaLabel?.(row.original)}
              tabIndex={onRowClick !== undefined ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row.original);
                      }
                    }
                  : undefined
              }
            >
              {row.getVisibleCells().map((cell, i) => {
                const numeric = columns[i]?.numeric === true;
                return (
                  <TableCell key={cell.id} className={cn(numeric && 'text-right num')}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <span className="sr-only" role="status">
        共 {rows.length} 条记录
      </span>
    </div>
  );
}
