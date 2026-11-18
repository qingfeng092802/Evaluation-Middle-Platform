/**
 * `GET/PATCH /api/integrations/github/{integrationId}` —— 集成详情 / 更新（M5）。
 *
 * 详情响应是**泄密扫描的锚点**：只有 `hasPrivateKey` / `hasWebhookSecret` 布尔位，
 * 零 PEM / secret 明文（`webhook-inbound.spec.ts` API 级扫描）。
 * 不存在 ⇒ 服务层 404（错误响应同样零凭据）。
 */
import type { NextRequest } from 'next/server';
import { GithubIntegration } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { getIntegration, updateIntegration } from '@/lib/api/services/githubIntegrations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ integrationId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { integrationId } = await ctx.params;
    return ok(GithubIntegration, await getIntegration(integrationId));
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ integrationId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { integrationId } = await ctx.params;
    return ok(GithubIntegration, await updateIntegration(integrationId, await readJson(req)));
  });
}
