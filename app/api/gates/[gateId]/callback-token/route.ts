/**
 * `POST /api/gates/{gateId}/callback-token` —— 签发 CI 回调 Token（`US-018`，Q1=C）。
 *
 * 明文仅在本次响应中返回一次；平台只落 SHA-256 哈希（0020 迁移，`trg_callback_tokens_immutable`
 * 保证写入后不可改——重置 = 重新签发一行）。MVP 口径：不过期（`expiresAt=null`）。
 */
import type { NextRequest } from 'next/server';
import { CallbackTokenResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { registerCallbackToken } from '@/lib/api/services/gates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ gateId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { gateId } = await ctx.params;
    return ok(CallbackTokenResponse, await registerCallbackToken(gateId));
  });
}
