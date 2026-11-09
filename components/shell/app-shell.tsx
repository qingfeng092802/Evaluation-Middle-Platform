'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { ThemeToggle } from './theme-toggle';
import { NAV_SECTIONS, resolveActiveNav } from '@/lib/ui/nav';

/**
 * 工作台外壳。
 *
 * 布局硬约束（`DESIGN.md` §1.2）：侧栏固定宽度 + 顶部栏 48px + 内容区 24px 内边距。
 * 折叠状态存在组件内：M1 不引入全局状态库，一个布尔值不值得建 store。
 *
 * 导航结构从 `lib/ui/nav.ts` 取（那处被单测锁死为 4 个分区），
 * 本文件只做渲染，不参与「有哪些分区」的决策。
 */
export function AppShell({
  breadcrumbs,
  actions,
  children,
}: {
  breadcrumbs: readonly { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const activeHref = resolveActiveNav(pathname);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        sections={NAV_SECTIONS}
        {...(activeHref === undefined ? {} : { activeHref })}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar breadcrumbs={breadcrumbs} actions={actions} />
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</main>
      </div>
    </div>
  );
}

/**
 * 带主题切换按钮的外壳。
 *
 * 单独一个组件而不是把 `ThemeToggle` 塞进 `AppShell` 的 `actions`：
 * `actions` 是**页面级**快捷操作（「发起评测」「去配置」），
 * 主题切换是全局偏好，两者混在一个插槽里会挤掉真正的页面动作。
 */
export function AppShellWithTheme(props: {
  breadcrumbs: readonly { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <AppShell
      breadcrumbs={props.breadcrumbs}
      actions={
        <>
          {props.actions}
          <ThemeToggle />
        </>
      }
    >
      {props.children}
    </AppShell>
  );
}
