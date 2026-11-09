'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface TopbarProps {
  /** 面包屑。`PG-03` 的形态：`评测运行 / 客服问答集 v3 / #<caseKey 前 8 位>`。 */
  readonly breadcrumbs: readonly { label: string; href?: string }[];
  /** 右侧快捷操作（按钮）。 */
  readonly actions?: React.ReactNode;
  readonly className?: string;
}

/**
 * 顶部栏（48px，单行面包屑 + 右对齐快捷操作，`DESIGN.md` §1.2）。
 *
 * 只允许**一行**：面包屑过长时截断而不是换行——换行会让 48px 高度失效，
 * 整个内容区会被顶下去，滚动位置随之跳动。
 */
export function Topbar({ breadcrumbs, actions, className }: TopbarProps): React.ReactElement {
  return (
    <header
      className={cn(
        'flex h-topbar shrink-0 items-center gap-3 border-b border-border bg-card px-6',
        className,
      )}
    >
      <nav aria-label="面包屑" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-xs">
          {breadcrumbs.map((crumb, i) => {
            const last = i === breadcrumbs.length - 1;
            return (
              <li key={`${crumb.label}-${String(i)}`} className="flex min-w-0 items-center gap-1.5">
                {i > 0 ? (
                  <span className="text-muted-foreground" aria-hidden="true">
                    /
                  </span>
                ) : null}
                {crumb.href !== undefined && !last ? (
                  <a href={crumb.href} className="truncate text-muted-foreground hover:text-foreground">
                    {crumb.label}
                  </a>
                ) : (
                  <span
                    className={cn('truncate', last ? 'font-medium text-foreground' : 'text-muted-foreground')}
                    aria-current={last ? 'page' : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
