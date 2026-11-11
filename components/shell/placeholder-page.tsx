import * as React from 'react';
import Link from 'next/link';
import { placeholderNotice, type PlaceholderKey } from '@/lib/ui/derive';

/**
 * 未上线页面的占位视图（`SPEC-M1` §6.5 `T-3`，需求方 2026-11-10「方案 A」）。
 *
 * **刻意做成无状态的服务端组件**：占位页的头号风险是有人「顺手」给它接上假数据
 * 或半个筛选器，于是一个本该明确说「还没到」的页面变成了看着能用、
 * 实际全是编的东西。没有 `'use client'`、没有 hooks、没有取数，
 * 从结构上就杜绝了这件事。
 *
 * 外壳（侧栏 / 顶栏）由调用方提供：本组件只负责说明区块，
 * 这样它在单测里能被 `renderToStaticMarkup` 直接渲染，不需要 Router 上下文。
 */
export function PlaceholderPage({ noticeKey }: { noticeKey: PlaceholderKey }): React.ReactElement {
  const notice = placeholderNotice(noticeKey);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-semibold text-foreground">{notice.title}</h1>
        <span className="num-mono text-2xs text-subtle">{notice.pageId}</span>
      </div>

      <div className="rounded-md border border-border bg-card px-4 py-5">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">{notice.message}</p>
          <p className="text-sm text-body">{notice.reason}</p>
          <p className="text-2xs text-subtle">
            里程碑归属：<span className="num-mono">{notice.milestone}</span>
          </p>
        </div>
      </div>

      <div>
        <Link
          href={notice.fallback.href}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {notice.fallback.label}
        </Link>
      </div>
    </div>
  );
}
