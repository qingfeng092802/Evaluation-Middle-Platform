/**
 * `GET /api/gates/{gateId}/dispatch-logs` —— 出站派发历史（0021，US-018）。
 *
 * 每次派发尝试一行，只追加不可改写（表级不可变触发器）。
 * FAILED 行必带 `errorMessage`；gate 不存在 → 服务层 404。
 */
import type { NextRequest } from 'next/server';
import { DispatchLogListResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { listDispatchLogs } from '@/lib/api/services/gates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ gateId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { gateId } = await ctx.params;
    return ok(DispatchLogListResponse, await listDispatchLogs(gateId));
  });
}
