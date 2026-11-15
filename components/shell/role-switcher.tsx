'use client';

import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { getRole, setRole, subscribeRole, type PlatformRole } from '@/lib/ui/role';

/**
 * 角色切换（MVP，需求方 2026-11-15 裁定 1）。
 *
 * `decision` 接口仅 ROLE-B 可调（非 B → 403），而 MVP 不做登录（OUT-4）——
 * 顶栏需要一个把「当前角色」注入 `X-Role` Header 的入口，默认 A。
 *
 * 用原生 `<select>` 而非 shadcn/radix Select：radix-select 不在依赖清单里，
 * 为一个两选项的极简控件在构建期拉新包不值（与 ThemeToggle 不引入
 * `next-themes` 同一判断）。视觉走语义 Token，尺寸对齐顶栏 48px 内的
 * `h-7` 惯例（`DESIGN.md` §1.2）。
 */
const ROLES: ReadonlyArray<{ readonly value: PlatformRole; readonly label: string }> = [
  { value: 'A', label: 'A · 研发' },
  { value: 'B', label: 'B · 管理员' },
];

export function RoleSwitcher(): React.ReactElement {
  const role = useSyncExternalStore(subscribeRole, getRole);
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>角色</span>
      <select
        aria-label="当前角色"
        title="MVP 角色模拟：B 可确认 / 驳回基线（decision 接口）"
        value={role}
        onChange={(e) => setRole(e.target.value as PlatformRole)}
        className="h-7 rounded-sm border border-border bg-card px-1.5 text-xs text-foreground transition-colors duration-[120ms] hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {ROLES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}
