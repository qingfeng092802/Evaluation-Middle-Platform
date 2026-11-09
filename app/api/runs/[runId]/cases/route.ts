/**
 * `GET /api/runs/{runId}/cases`（`PG-03` 明细表）。
 *
 * M1 只启用 `sortBy` + `order`（P0 的排序需求就是「按得分/耗时看谁最差」），
 * 其余筛选条件在契约里存在但恒为 undefined，不做半成品筛选。
 */
import type { NextRequest } from 'next/server';
import { EvalCaseResultListResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { listRunCases } from '@/lib/api/services/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { runId } = await ctx.params;
    const { items, limit } = await listRunCases(runId, new URL(req.url));
    return ok(EvalCaseResultListResponse, { items, page: pageMeta(limit) });
  });
}
