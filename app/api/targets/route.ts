/**
 * `GET /api/targets` · `POST /api/targets`（`PG-06`）。
 *
 * POST 同时生成 v1：不存在「没有版本的 Target」，那样它就无法被选进 `PG-02`。
 */
import type { NextRequest } from 'next/server';
import { PageQuery, Target, TargetListResponse } from '@eval-platform/contracts';
import { handle, ok, parseQuery, readJson } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { createTarget, listTargetPage } from '@/lib/api/services/targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const q = parseQuery(PageQuery, new URL(req.url));
    const items = await listTargetPage(q.limit);
    return ok(TargetListResponse, { items, page: pageMeta(items.length) });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    return ok(Target, await createTarget(await readJson(req)), 201);
  });
}
