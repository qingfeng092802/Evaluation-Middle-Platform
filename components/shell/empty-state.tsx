import * as React from 'react';
import { cn } from '@/lib/utils';
import { emptyState, type EmptyStateKey } from '@/lib/ui/derive';

/** 键类型从此处再导出，调用方（`DataTable`）只依赖组件模块。 */
export type { EmptyStateKey };

/**
 * 空状态。
 *
 * 文案从 `lib/ui/derive.ts` 取，**不在组件里写字符串**：
 * 那样三处页面就会各写一句「暂无数据」，原文一旦定稿就再也对不齐。
 *
 * 结构：真实文案 + 引导行动（`DESIGN.md` §6.1 要求「真实文案 + 主行动链接」）。
 */
export function EmptyState({
  stateKey,
  className,
  children,
}: {
  stateKey: EmptyStateKey;
  className?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const state = emptyState(stateKey);
  return (
    <div
      className={cn(
        'flex min-h-[160px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
    >
      <p className="text-sm text-muted-foreground">{state.message}</p>
      {state.actions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {state.actions.map((a) => (
            <a
              key={a.href}
              href={a.href}
              className={cn(
                'inline-flex h-8 min-h-tap items-center rounded-md border border-input bg-card px-3',
                'text-sm text-foreground transition-colors duration-[120ms] hover:bg-muted',
              )}
            >
              {a.label}
            </a>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}
