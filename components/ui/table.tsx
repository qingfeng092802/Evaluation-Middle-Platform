import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 表格原始元素。
 *
 * 硬要求（`DESIGN.md` §8）：真实 `<table>` 语义，不用 `div` 拼网格。
 * 行高 36px / 表头 32px / 字号 13px 由 Token 控制，不在这里写死。
 */
export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>): React.ReactElement {
  return (
    <table className={cn('w-full border-collapse text-sm', className)} {...props} />
  );
}

export function TableHead({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.ReactElement {
  return <thead className={cn('border-b border-border', className)} {...props} />;
}

export function TableBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.ReactElement {
  return <tbody className={className} {...props} />;
}

export function TableRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>): React.ReactElement {
  return <tr className={cn('h-row-h border-b border-border last:border-0', className)} {...props} />;
}

export function TableHeaderCell({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>): React.ReactElement {
  // 表头 12px / 500 / muted-foreground（DESIGN §3.4）
  return (
    <th
      scope="col"
      className={cn(
        'h-thead-h whitespace-nowrap px-3 text-left text-xs font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>): React.ReactElement {
  return (
    <td className={cn('px-3 align-middle text-body', className)} {...props} />
  );
}
