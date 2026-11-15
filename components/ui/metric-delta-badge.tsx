import * as React from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Badge } from './badge';
import type { MetricDeltaView } from '@/lib/ui/compare';

/**
 * 变化徽章（`DESIGN.md` §4.1 `MetricDeltaBadge`）。
 *
 * 语义（含 higherIsBetter 反转）由 `metricDeltaView()` 纯函数给出，
 * 本组件只做渲染——`无基线` / `不可比` 渲染为灰色文字，**绝不渲染 +0.0000**
 * （`+0` 会被读成「没变化」，与「没有可比对象」是两件事）。
 * 方向同时用符号与图标编码（WCAG 1.4.1：颜色不是唯一编码）。
 */
export function MetricDeltaBadge({ view }: { view: MetricDeltaView }): React.ReactElement {
  if (view.kind === 'text') {
    return <span className="text-xs font-medium text-muted-foreground">{view.text}</span>;
  }
  return (
    <Badge variant={view.variant} role="status" aria-label={view.ariaLabel} className="num">
      <span>{view.deltaText}</span>
      {view.arrow === '▲' ? (
        <TrendingUp className="h-3 w-3" aria-hidden="true" />
      ) : view.arrow === '▼' ? (
        <TrendingDown className="h-3 w-3" aria-hidden="true" />
      ) : null}
    </Badge>
  );
}
