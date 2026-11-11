import * as React from 'react';
import type { Metadata } from 'next';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

/**
 * `P2 / PG-08` 报告对比 · **占位路由**。
 *
 * `SPEC-M1` §6.5 `T-3`：`PG-08` 属 M3，补齐需要新增对比契约、`baselines` 数据与对比接口，
 * 均在 M1 授权之外。M1 只保证「用户走到这个 URL 时看到一句实话」，而不是 404。
 *
 * 路径取 `/runs/compare`：静态段优先于 `/runs/[runId]` 动态段，
 * 因此不会被当成一个 `runId` 去查库（`runId` 另有 `Uuid` 校验）。
 */
export const metadata: Metadata = { title: '报告对比' };

export default function RunsComparePage(): React.ReactElement {
  return (
    <AppShellWithTheme breadcrumbs={[{ label: '评测运行', href: '/runs' }, { label: '报告对比' }]}>
      <PlaceholderPage noticeKey="pg08" />
    </AppShellWithTheme>
  );
}
