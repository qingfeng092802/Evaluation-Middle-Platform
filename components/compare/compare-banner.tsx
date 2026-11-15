import * as React from 'react';
import { cn } from '@/lib/utils';
import type { CompareBannerView } from '@/lib/ui/compare';

/**
 * PG-08 约束横幅（`pages-and-flows.md` PG-08「约束横幅」）。
 *
 * 两态：`warn` = 未确认基线（文案为**契约原文逐字**，`BL-2`）；
 * `pass` = 本次对比的基线就是已确认基线（绿色氛围，无警告）。
 * `role="status"`：横幅出现/变化时读屏可感知。
 */
export function CompareBanner({ tone, text }: CompareBannerView): React.ReactElement {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-sm border px-3 py-2 text-xs',
        tone === 'pass'
          ? 'border-transparent bg-eval-pass-bg text-eval-pass'
          : 'border-transparent bg-eval-warn-bg text-eval-warn',
      )}
    >
      <span className="font-medium">{text}</span>
    </div>
  );
}
