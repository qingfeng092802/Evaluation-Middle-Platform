'use client';

import * as React from 'react';
import {
  Activity,
  Database,
  ListChecks,
  Play,
  Settings,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NavIconName, NavItemSpec, NavSectionSpec } from '@/lib/ui/nav';

/** 图标名 → 组件。只从 `lucide-react` 顶层导入，禁深引 `lucide/dist`（TS-5）。 */
const NAV_ICONS: Readonly<Record<NavIconName, LucideIcon>> = {
  Activity,
  Play,
  Database,
  Target,
  ListChecks,
  Settings,
};

interface SidebarProps {
  readonly sections: readonly NavSectionSpec[];
  readonly activeHref?: string;
  readonly collapsed?: boolean;
  readonly onToggleCollapsed?: () => void;
}

/**
 * 侧边导航（220px / 折叠 56px，`DESIGN.md` §1.2）。
 *
 * **只有 4 个分区**（运行 / 资产 / 算子 / 管理），不得新增第 5 个（§1.3 硬约束）。
 * 折叠态只留图标 + `title` tooltip：鼠标悬停可见，键盘聚焦也可见（`title` 是原生行为）。
 */
export function Sidebar({
  sections,
  activeHref,
  collapsed = false,
  onToggleCollapsed,
}: SidebarProps): React.ReactElement {
  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-border bg-card',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
      )}
      aria-label="主导航"
    >
      <div className="flex h-topbar shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate text-sm font-semibold tracking-tight text-foreground">
          {collapsed ? 'EP' : '评测中台'}
        </span>
        {onToggleCollapsed !== undefined ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="ml-auto inline-flex h-6 w-6 min-h-tap min-w-tap items-center justify-center rounded-sm text-muted-foreground transition-colors duration-[120ms] hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? '展开侧边导航' : '收起侧边导航'}
            aria-expanded={!collapsed}
          >
            <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
          </button>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {sections.map((section) => (
          <div key={section.title} className="mb-3">
            {!collapsed ? (
              // 分组标题：sentence case + font-medium + muted-foreground，不用 ALL-CAPS eyebrow（DESIGN §1.1）
              <div className="px-3 pb-1 text-2xs font-medium text-muted-foreground">
                {section.title}
              </div>
            ) : (
              <div className="sr-only">{section.title}</div>
            )}
            <ul>
              {section.items.map((item) => (
                <NavRow
                  key={item.href}
                  item={item}
                  active={activeHref !== undefined && activeHref === item.href}
                  collapsed={collapsed}
                />
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function NavRow({
  item,
  active,
  collapsed,
}: {
  item: NavItemSpec;
  active: boolean;
  collapsed: boolean;
}): React.ReactElement {
  const Icon = NAV_ICONS[item.icon];
  const inner = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
      {!collapsed && item.badge !== undefined ? (
        <span className="ml-auto rounded-sm bg-muted px-1.5 text-2xs text-muted-foreground">
          {item.badge}
        </span>
      ) : null}
    </>
  );

  return (
    <li>
      {item.disabled === true ? (
        <span
          className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground/60"
          aria-disabled="true"
          title={`${item.label}（P1 支持）`}
        >
          {inner}
        </span>
      ) : (
        <a
          href={item.href}
          aria-current={active ? 'page' : undefined}
          title={collapsed ? item.label : undefined}
          className={cn(
            'flex h-8 items-center gap-2 rounded-sm px-3 text-sm transition-colors duration-[120ms]',
            active
              ? 'bg-muted font-medium text-foreground'
              : 'text-body hover:bg-muted hover:text-foreground',
          )}
        >
          {inner}
        </a>
      )}
    </li>
  );
}
