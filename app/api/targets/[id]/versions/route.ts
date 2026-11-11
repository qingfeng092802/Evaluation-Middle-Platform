/**
 * `GET /api/targets/{id}/versions`（`PG-06`）。
 *
 * 版本只增不改：没有 POST / PATCH / DELETE 入口。
 */
import type { NextRequest } from 'next/server';
import { TargetVersionListResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { listTargetVersions } from '@/lib/api/services/targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const items = await listTargetVersions(id);
    return ok(TargetVersionListResponse, { items, page: pageMeta(items.length) });
  });
}
