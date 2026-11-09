import * as React from 'react';
import { cn } from '@/lib/utils';

/** 卡片：用 1px 边框表达层级，**默认无阴影**（`DESIGN.md` §1.1）。 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('rounded-md border border-border bg-card', className)} {...props} />;
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('flex flex-col gap-1 px-4 pt-3 pb-2', className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
  // 区块标题 14px / 600（DESIGN §3.4）
  return <h3 className={cn('text-base font-semibold text-foreground', className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}
