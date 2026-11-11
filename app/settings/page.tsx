import * as React from 'react';
import type { Metadata } from 'next';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

/**
 * `P6 / PG-09` 管理配置 · **占位路由**。
 *
 * `SPEC-M1` §6.5 `T-3`：模型网关 Tab 属 **M2**（M1 只有本地 fixture 网关，
 * 配置界面此刻是假功能），门禁规则 / 基线确认 / 推送渠道三个 Tab 属 **M4**。
 *
 * `PG-01` 未配凭证横幅上的「去配置」正是指向这里 —— `[FE-03]` 明令「不得做成死链」，
 * 所以这个路由必须存在，哪怕它只说一句「还没上线」。
 */
export const metadata: Metadata = { title: '管理配置' };

export default function SettingsPage(): React.ReactElement {
  return (
    <AppShellWithTheme breadcrumbs={[{ label: '管理' }, { label: '管理配置' }]}>
      <PlaceholderPage noticeKey="pg09" />
    </AppShellWithTheme>
  );
}
