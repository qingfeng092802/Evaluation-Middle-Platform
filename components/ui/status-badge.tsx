'use client';

import * as React from 'react';
import {
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Loader,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { RunStatus } from '@eval-platform/contracts';
import {
  describeRunStatus,
  runStatusAnimated,
  runStatusIcon,
  runStatusTone,
  type RunStatusIconName,
  type StatusTone,
} from '@/lib/ui/derive';
import { Badge } from '@/components/ui/badge';

/**
 * `RUNNING` 的图标在渲染时必须旋转（`DESIGN.md` §4.4「Loader（脉冲点）」）。
 * 这里用 `animate-spin`（来自 tailwindcss-animate 的基类，非自定义动效），
 * 其余状态一律静止。
 */
const ICONS: Readonly<Record<RunStatusIconName, LucideIcon>> = {
  Clock,
  Loader,
  CircleCheck,
  TriangleAlert,
  CircleX,
  CircleSlash,
};

/** 语义档 → `Badge` 变体。一一对应，不做兜底变体，漏了会编译报错。 */
const TONE_VARIANT: Readonly<Record<StatusTone, 'muted' | 'running' | 'pass' | 'warn' | 'fail'>> = {
  muted: 'muted',
  running: 'running',
  pass: 'pass',
  warn: 'warn',
  fail: 'fail',
};

/**
 * 运行状态徽章（`RS-01`…`RS-06`）。
 *
 * 三重区分（`pages-and-flows.md` §4.1 已拍板）：**颜色 + 图标 + 文案**。
 * 只靠颜色的话，红绿色盲用户看到 `FAILED` 与 `COMPLETED` 会是同一个东西。
 */
export function StatusBadge({
  status,
  className,
}: {
  status: RunStatus;
  className?: string;
}): React.ReactElement {
  const Icon = ICONS[runStatusIcon(status)];
  const animated = runStatusAnimated(status);

  return (
    <Badge variant={TONE_VARIANT[runStatusTone(status)]} className={className}>
      <Icon
        className={['h-3 w-3 shrink-0', animated ? 'animate-spin' : ''].join(' ').trim()}
        aria-hidden={true}
      />
      <span>{describeRunStatus(status)}</span>
    </Badge>
  );
}
