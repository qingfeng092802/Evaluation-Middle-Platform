/**
 * `GET /api/datasets` · `POST /api/datasets`（`PG-05` 列表与建容器）。
 */
import type { NextRequest } from 'next/server';
import { DatasetListQuery, DatasetListResponse, Dataset } from '@eval-platform/contracts';
import { handle, ok, parseQuery, readJson } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { createDataset, listDatasetPage } from '@/lib/api/services/datasets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const q = parseQuery(DatasetListQuery, new URL(req.url));
    const items = await listDatasetPage({ limit: q.limit, keyword: q.keyword });
    return ok(DatasetListResponse, { items, page: pageMeta(items.length) });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const created = await createDataset(await readJson(req));
    return ok(Dataset, created, 201);
  });
}
