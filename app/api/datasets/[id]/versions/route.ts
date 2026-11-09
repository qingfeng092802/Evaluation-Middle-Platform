/**
 * `GET /api/datasets/{id}/versions` · `POST /api/datasets/{id}/versions`（`PG-05`）。
 *
 * POST = 导入并生成版本（一次导入 = 一个新版本，`PT-2`）。
 * 冲突（同指纹 / 期望指纹不符）一律 409，`details.existingVersionNo` 指向已有版本。
 */
import type { NextRequest } from 'next/server';
import { DatasetVersion, DatasetVersionListResponse } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { commitDatasetVersion, listDatasetVersions } from '@/lib/api/services/datasets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const items = await listDatasetVersions(id);
    return ok(DatasetVersionListResponse, { items, page: pageMeta(items.length) });
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const version = await commitDatasetVersion(id, await readJson(req));
    // 201 + 版本行（详情由 GET /versions/{versionNo} 取，避免一次响应塞 50 条 Case）
    return ok(DatasetVersion, version, 201);
  });
}

