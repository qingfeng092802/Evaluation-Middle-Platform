/**
 * `PATCH /api/providers/{providerId}` —— 更新厂商（`PG-09`，契约见 openapi:854）。
 *
 * 动词是 **PATCH 而非 PUT**：契约写的是「更新厂商（apiKey 省略则保留原值）」，
 * 即部分更新语义。用 PUT 会让人以为「没传的字段该清空」，而清空密钥是这页
 * 最不该被顺手做出来的操作。
 *
 * 响应 200 + `ModelProvider`（不含 Key）。不存在 ⇒ 服务层抛 `NotFoundError` ⇒ 404。
 */
import type { NextRequest } from 'next/server';
import { ModelProvider } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { updateProvider } from '@/lib/api/services/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ providerId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { providerId } = await ctx.params;
    return ok(ModelProvider, await updateProvider(providerId, await readJson(req)));
  });
}
