'use client';

import * as React from 'react';
import { connectionLabel, connectionTone, type StreamConnection } from '@/lib/ui/run-stream-client';
import { cn } from '@/lib/utils';

/**
 * 连接指示灯（`DESIGN.md` §4.2 的「连接三态」）。
 *
 * 三态**各自有文案**（`已连接` / `重连中` / `已断开`），颜色只是加强：
 * WCAG 1.4.1 要求颜色不能是唯一编码 —— 色盲用户看两个灰点分不出连没连上。
 *
 * 呼吸脉冲只挂在 **8px 圆点**上，不施加于整个徽章：大面积持续脉动是闪烁风险。
 * `prefers-reduced-motion: reduce` 时降级为静态实心点。
 *
 * `aria-live="polite"` + `aria-atomic="false"`：只播报**连接态变化**与
 * **每 10% 里程碑**（由 `announcement` 传入），绝不逐条 Case 播报 ——
 * 300 条 Case 会把读屏刷爆，用户只会把读屏关掉。
 */
export interface StreamConnectionIndicatorProps {
  readonly connection: StreamConnection;
  /** 需播报的文案；`null` ⇒ 本次不播（绝大多数帧都是这种情况）。 */
  readonly announcement: string | null;
}

const TONE_CLASS: Readonly<Record<ReturnType<typeof connectionTone>, string>> = {
  running: 'text-eval-running',
  warn: 'text-eval-warn',
  fail: 'text-eval-fail',
};

const DOT_CLASS: Readonly<Record<ReturnType<typeof connectionTone>, string>> = {
  running: 'bg-eval-running-mark animate-eval-pulse motion-reduce:animate-none',
  warn: 'bg-eval-warn-mark',
  fail: 'bg-eval-fail-mark',
};

export function StreamConnectionIndicator({
  connection,
  announcement,
}: StreamConnectionIndicatorProps): React.ReactElement {
  const tone = connectionTone(connection);

  return (
    <span
      className="flex items-center gap-1.5 text-2xs"
      aria-live="polite"
      aria-atomic="false"
    >
      <span className={cn('flex items-center gap-1.5', TONE_CLASS[tone])}>
        <span
          className={cn('h-2 w-2 rounded-full', DOT_CLASS[tone])}
          aria-hidden="true"
        />
        {connectionLabel(connection)}
      </span>
      {/*
        播报区与视觉指示灯分开：视觉上的「已连接」是常驻的，
        播报则只在**变化**那一刻发生一次。混在一起读屏会反复念同一句。
      */}
      <span className="sr-only">{announcement ?? ''}</span>
    </span>
  );
}
