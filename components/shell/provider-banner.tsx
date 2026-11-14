'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showProviderBanner } from '@/lib/ui/runs';
import { useProviderStatus } from '@/lib/ui/provider-status';

/**
 * `PG-01` 区域 2 · 前置依赖横幅（`US-015`）。
 *
 * 文案逐字取自 `pages-and-flows.md` §1 PG-01 与 §5：
 * 「尚未配置模型网关凭证，无法发起评测。［去配置］」。
 *
 * **「去配置」现在是真链接。** M1 时它只能展开一段就地说明，因为 `PG-09`
 * 尚不存在，指向一个 404 就是死链（`[FE-03]` 明令禁止）。M2 · Batch 2 交付了
 * 「模型网关」Tab，`/settings` 从占位变成真实页面，因此这里改成跳转——
 * 让用户点一下就能去配 Key，而不是读一段「请找管理员改数据库」。
 *
 * 显示条件严格由 `showProviderBanner()` 决定（已单测：只看 `hasProviderCredentials`，
 * `null` 一律不显示），因此探测失败不会被误报成「你没配凭证」。
 */
export function ProviderBanner(): React.ReactElement | null {
  const { preflight } = useProviderStatus();

  if (!showProviderBanner(preflight)) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-eval-warn bg-eval-warn-bg px-3 py-2"
    >
      <TriangleAlert className="h-4 w-4 shrink-0 text-eval-warn" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-eval-warn">
        尚未配置模型网关凭证，无法发起评测。
      </p>
      <Button asChild variant="outline" size="sm">
        <a href="/settings">去配置</a>
      </Button>
    </div>
  );
}
