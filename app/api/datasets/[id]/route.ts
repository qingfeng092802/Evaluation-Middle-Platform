/**
 * `GET /api/datasets/{id}` · `PATCH /api/datasets/{id}`（`PG-05`）。
 *
 * PATCH 只接受名称 / 描述（`DatasetUpdate`）——条目与版本号没有更新入口，
 * 契约里就不存在这种形状，所以这里也不需要写任何「拒绝改其它字段」的代码。
 */
import type { NextRequest } from 'next/server';
import { Dataset } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { getDatasetOrThrow, updateDataset } from '@/lib/api/services/datasets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return ok(Dataset, await getDatasetOrThrow(id));
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return ok(Dataset, await updateDataset(id, await readJson(req)));
  });
}
