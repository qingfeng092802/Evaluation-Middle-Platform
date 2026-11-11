/**
 * `GET /api/datasets/{id}/versions/{versionNo}`（`PG-05` 预览）。
 *
 * 返回 `DatasetVersionDetail`：版本 + Case 预览 + **`immutable: true`**。
 * 那个 `true` 是字面量类型而不是布尔值，前端据此不必自己推断「这个版本能不能改」。
 */
import type { NextRequest } from 'next/server';
import { DatasetVersionDetail } from '@eval-platform/contracts';
import { BadRequestError, handle, ok } from '@/lib/api/http';
import { getVersionDetailOrThrow } from '@/lib/api/services/datasets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; versionNo: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id, versionNo } = await ctx.params;
    const n = Number(versionNo);
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestError('版本号必须是 ≥ 1 的整数', { versionNo });
    }
    return ok(DatasetVersionDetail, await getVersionDetailOrThrow(id, n));
  });
}
