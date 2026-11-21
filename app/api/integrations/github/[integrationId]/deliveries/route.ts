/**
 * `GET /api/integrations/github/{integrationId}/deliveries` —— Webhook 投递历史
 * （M5 Batch 4，PG-09「GitHub 集成」区块）。0022 只追加账本的倒序读取；
 * 集成不存在 ⇒ 服务层 404。
 */
import type { NextRequest } from 'next/server';
import { GithubDeliveryListResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { listDeliveries } from '@/lib/api/services/githubIntegrations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ integrationId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { integrationId } = await ctx.params;
    return ok(GithubDeliveryListResponse, await listDeliveries(integrationId));
  });
}
