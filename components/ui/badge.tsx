import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * 徽章。数值类内容必须自带 `.num`（`DESIGN.md` §3.2）。
 *
 * `eval` 变体的三档结构（`fg` / `bg` / `mark`）不是随意拆的：
 * 600 级色号作文字色不达 WCAG AA，所以文字用 `fg`（700–800 级）、底用 `bg`。
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-muted text-body',
        outline: 'border-border bg-card text-body',
        pass: 'border-transparent bg-eval-pass-bg text-eval-pass',
        fail: 'border-transparent bg-eval-fail-bg text-eval-fail',
        warn: 'border-transparent bg-eval-warn-bg text-eval-warn',
        running: 'border-transparent bg-eval-running-bg text-eval-running',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
