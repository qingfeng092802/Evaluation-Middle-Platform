/**
 * `POST /api/integrations/github/webhook` —— GitHub Webhook 入站（M5，`US-022`）。
 *
 * 鉴权为 HMAC-SHA256（`X-Hub-Signature-256`，密钥 = 集成 `webhook_secret`），
 * **不走** 回调 Token / 角色——GitHub 是唯一合法发送方（`SPEC-M5.md` §附录 C）。
 * 处理顺序与响应口径见 `lib/api/services/githubWebhook.ts` 的文件头；
 * `handle()` 统一翻译错误（`UnauthorizedError` → 401 且零凭据信封）。
 */
import type { NextRequest } from 'next/server';
import { WebhookResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { processWebhook } from '@/lib/api/services/githubWebhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const rawBody = await req.text();
  return handle(async () => {
    const outcome = await processWebhook(
      {
        signature: req.headers.get('x-hub-signature-256'),
        event: req.headers.get('x-github-event'),
        deliveryId: req.headers.get('x-github-delivery'),
      },
      rawBody,
    );
    return ok(WebhookResponse, outcome.body, outcome.httpStatus);
  });
}
