import type { Metadata, Viewport } from 'next';
import * as React from 'react';

/*
 * 字体本地化（`DESIGN.md` §3.1 / `[FE-01]` 交付物 3）。
 *
 * 用 `@fontsource/*` 而不是 `next/font/google`：后者在**构建期**要访问
 * `fonts.googleapis.com`，直接违反「构建期不联网」与「全站零外部请求」两条硬约束。
 * 这里只取实际用到的字重，Family 名与 `tailwind.config.ts` 的 `fontFamily` 逐字一致。
 */
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

import './globals.css';
import { THEME_BOOT_SCRIPT } from '@/lib/ui/theme';

export const metadata: Metadata = {
  title: {
    default: '评测中台',
    template: '%s · 评测中台',
  },
  description: '企业级 AI 评测中台 · 确定性评测闭环',
  // 零外部资源：不配任何 font/icon CDN，头图也不引外链。
  icons: { icon: '/favicon.ico' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 表格有横向溢出时靠容器滚动，不允许整页缩放
  maximumScale: 5,
};

/**
 * 根布局。
 *
 * `suppressHydrationWarning` 只加在 `<html>` 上：主题脚本会在 hydration 前
 * 给 `<html>` 加 `dark` class，React 看到 class 不一致会报警告。
 * 这是该属性的**唯一**正当用途，不要顺手加到 `<body>` 或业务节点上。
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首帧前执行：深色用户不会先闪一帧白（源码与测试见 lib/ui/theme.ts）。 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
