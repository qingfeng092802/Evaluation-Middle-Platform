'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import type { RunStatus } from '@eval-platform/contracts';
import { progressLabel, progressPercent } from '@/lib/ui/runs';

/**
 * `PG-03` 区域 3「运行中条」：`已完成 128 / 300，失败 2` + 进度条 + 「实时更新中」。
 *
 * **props 只吃聚合值，不吃 `EvalRunDetail`**：M2 把轮询换成 SSE 时，页面把
 * `CaseEvent` 的字段喂进同名的这几个 prop 即可，本组件一行都不用改。
 * 字段名与类型刻意取自 `CaseEvent`（`completedCount` / `totalCount` /
 * `score` / `passed` / `latencyMs`）——M1 轮询拿不到「最新一条事件」，
 * 那三项恒为 `null`；M2 的 SSE 会填满它们。
 *
 * 为什么 `failedCount` 单独传：`CaseEvent` 是**单条**事件，里面没有累计失败数，
 * 而事实文档的原文 `已完成 128 / 300，失败 2` 里那个「2」正是累计值。
 */
export interface LiveRunProgressBarProps {
  /** 单调递增的已完成计数（成功 + 失败，与 `progressLabel` 同口径）。 */
  readonly completedCount: number;
  readonly totalCount: number;
  /** 累计失败条数。 */
  readonly failedCount: number;
  /** 运行状态：`PENDING` 显示「等待调度」而不是 `0 / 0`。 */
  readonly runStatus: RunStatus;
  /** 是否仍在实时更新（进入终态后转成静态，进度条保留最后一帧）。 */
  readonly live: boolean;
  /** 最新一条 Case 的得分；M1 轮询无此数据 ⇒ `null`。 */
  readonly score: number | null;
  /** 同上。 */
  readonly passed: boolean | null;
  /** 同上。 */
  readonly latencyMs: number | null;
}

export function LiveRunProgressBar({
  completedCount,
  totalCount,
  failedCount,
  runStatus,
  live,
}: LiveRunProgressBarProps): React.ReactElement {
  const pct = progressPercent(completedCount, totalCount);
  const label = progressLabel({
    status: runStatus,
    totalCases: totalCount,
    // `progressLabel` 自己加 failed 得到「已完成」；这里把 succeeded 反推回去，
    // 保证「已完成」与「失败」两个数出自同一组入参，不会出现 128 vs 126 的错位。
    succeededCases: Math.max(0, completedCount - failedCount),
    failedCases: failedCount,
  });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/*
          固定 `min-w` 而不是靠内容撑宽：计数从 99 涨到 100 时整条会左右抖一下。
          配合 `.num`（tabular-nums）数字段宽度才能稳定。
        */}
        <span className="num min-w-[22ch] text-xs text-foreground">{label}</span>
        {live ? (
          <span className="flex items-center gap-1.5 text-2xs text-eval-running">
            <span className="h-1.5 w-1.5 rounded-full bg-eval-running-mark" aria-hidden="true" />
            实时更新中
          </span>
        ) : null}
      </div>

      {/*
        用原生 `<progress>` 而不是两个 div：宽度由 `value`/`max` 属性表达，
        不需要 `style`（AS-2 禁止内联样式），也不需要动态生成 Tailwind 类
        （`w-[${pct}%]` 这种插值 Tailwind 扫描不到，会静默不生效）。
        读屏软件也原生认识它。
      */}
      <progress
        value={pct}
        max={100}
        aria-label="运行进度"
        className={cn(
          'h-1.5 w-full appearance-none overflow-hidden rounded-sm bg-muted',
          '[&::-webkit-progress-bar]:bg-muted',
          '[&::-webkit-progress-value]:bg-eval-running-mark',
          '[&::-moz-progress-bar]:bg-eval-running-mark',
          'transition-colors duration-200 ease-out',
        )}
      >
        {Math.round(pct)}%
      </progress>
    </div>
  );
}
