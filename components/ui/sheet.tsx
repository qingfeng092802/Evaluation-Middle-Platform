'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Sheet（右侧滑出抽屉，`PG-04`）。
 *
 * 基于 Radix Dialog，因此**自带** focus trap、`Esc` 关闭、关闭时焦点归还触发元素
 * （`DESIGN.md` §6.3 的三条要求）。自己用 `div` 拼一个"看起来像抽屉"的东西，
 * 这三条全都要手写且必然漏一条。
 *
 * 动效：300ms + `--sheet` 缓动，`prefers-reduced-motion` 下由 `globals.css` 统一中和。
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** 抽屉宽度。`PG-04` 用 720px；`< sm` 全屏（DESIGN §1.2）。 */
    width?: 'default' | 'wide';
  }
>(({ className, children, width = 'default', ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-foreground/20',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed inset-y-0 right-0 z-50 flex h-full flex-col border-l border-border bg-card shadow-overlay',
        'w-full sm:w-[720px]',
        width === 'wide' ? 'sm:w-[760px]' : 'sm:w-[680px]',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
        'duration-300 ease-sheet',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className={cn(
          'absolute right-3 top-3 inline-flex h-8 w-8 min-h-tap min-w-tap items-center justify-center',
          'rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
        aria-label="关闭"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = 'SheetContent';

export function SheetHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  // 固定头：头部不随内容滚走（DESIGN §4.3）
  return (
    <div
      className={cn('flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 pr-12', className)}
      {...props}
    />
  );
}

export function SheetBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-3', className)} {...props} />;
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>): React.ReactElement {
  return (
    <DialogPrimitive.Title
      className={cn('text-base font-semibold text-foreground', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>): React.ReactElement {
  return (
    <DialogPrimitive.Description
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}
