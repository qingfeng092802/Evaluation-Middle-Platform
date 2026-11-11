import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Skeleton。
 *
 * 关键要求（`DESIGN.md` §6.1）：**形状与真实行一致**（列宽、行高相同）。
 * 因此这里提供 `TableSkeleton` 而不是让各页面自己拼一堆 `animate-pulse`——
 * 各拼一份就必然与真实表格不同宽，加载完成时会「跳」一下。
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('animate-pulse rounded-sm bg-muted', className)} {...props} />;
}

/**
 * 表格骨架：默认 5 行、`cols` 列，行高 36px 与表头 32px 同真实表格。
 *
 * `aria-hidden` + 外层 `aria-busy` 由调用方给：
 * 骨架屏是视觉占位，不该被读屏逐格播报。
 */
export function TableSkeleton({
  cols = 6,
  rows = 5,
  className,
}: {
  cols?: number;
  rows?: number;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('w-full', className)} aria-hidden="true">
      <div className="flex h-8 items-center gap-4 border-b border-border px-2">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-9 items-center gap-4 border-b border-border px-2">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={c === 0 ? 'h-3 w-24' : 'h-3 flex-1'} />
          ))}
        </div>
      ))}
    </div>
  );
}
