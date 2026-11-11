import * as React from 'react';
import type { Metadata } from 'next';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

/**
 * `P5 / PG-07` 算子库 · **占位路由**。
 *
 * `SPEC-M1` §6.5 `T-3`：`PG-07` 属 M4（`evaluators` 表在 M1 是空表，
 * 六个内置算子直接内联在「发起评测」第 3 步，不需要独立页面）。
 * 侧栏该入口是 `disabled` 的置灰项；本路由只兜住手输 URL 的情形。
 */
export const metadata: Metadata = { title: '算子库' };

export default function EvaluatorsPage(): React.ReactElement {
  return (
    <AppShellWithTheme breadcrumbs={[{ label: '算子' }, { label: '算子库' }]}>
      <PlaceholderPage noticeKey="pg07" />
    </AppShellWithTheme>
  );
}
