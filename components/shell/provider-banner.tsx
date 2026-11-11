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
 * **「去配置」为什么不是链接**：它对应的 `PG-09 管理配置` 在 M1 不存在
 * （`NAV_SECTIONS` 里该入口是 `disabled` + `P1`）。指向一个 404 就是死链，
 * 而 `[FE-03]` 明令「不得做成死链」。因此这里展开一段就地说明，
 * 告诉用户当前版本为什么不需要配、以及该页何时可用 —— 信息量不低于跳转。
 *
 * 显示条件严格由 `showProviderBanner()` 决定（已单测：只看 `hasProviderCredentials`，
 * `null` 一律不显示），因此探测失败不会被误报成「你没配凭证」。
 */
export function ProviderBanner(): React.ReactElement | null {
  const { preflight } = useProviderStatus();
  const [expanded, setExpanded] = React.useState(false);

  if (!showProviderBanner(preflight)) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-eval-warn bg-eval-warn-bg px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TriangleAlert className="h-4 w-4 shrink-0 text-eval-warn" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-eval-warn">
          尚未配置模型网关凭证，无法发起评测。
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          去配置
        </Button>
      </div>
      {expanded ? (
        <p className="text-2xs text-muted-foreground">
          「管理配置 · 模型网关」页（PG-09）不在 M1 交付范围内。当前请由管理员在服务端启用一个
          provider（<span className="num-mono">model_providers.is_active = true</span>）后刷新本页。
        </p>
      ) : null}
    </div>
  );
}
