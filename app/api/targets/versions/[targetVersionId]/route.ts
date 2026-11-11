/**
 * `GET /api/targets/versions/{targetVersionId}`（`PG-02` 步骤 2）。
 *
 * 读取侧一律脱敏：T2 的 `authHeader` 变成 `hasAuthHeader`。
 * 该非对称由 `toVersionView()` 在仓储层实现，本文件拿不到明文。
 */
import type { NextRequest } from 'next/server';
import { TargetVersion } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { getTargetVersionOrThrow } from '@/lib/api/services/targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ targetVersionId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { targetVersionId } = await ctx.params;
    return ok(TargetVersion, await getTargetVersionOrThrow(targetVersionId));
  });
}
