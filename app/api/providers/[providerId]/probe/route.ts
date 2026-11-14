/**
 * `POST /api/providers/{providerId}/probe` —— 厂商连通性测试（`US-015` / `PG-09`）。
 *
 * 契约已在 Batch 1 锁定（`contracts/src/provider.ts` 的
 * `ModelProviderProbeRequest` / `ModelProviderProbeResult`），本文件只做接线。
 *
 * 两点必须守住：
 *  1. **出站过契约**：`ok(ModelProviderProbeResult, …)` 会把响应体再 parse 一遍，
 *     谁往响应里塞 `apiKey` 都会在这里炸，而不是在浏览器里悄悄泄露；
 *  2. **请求体的明文 Key 不落日志**：本文件不 console 任何入参。
 */
import type { NextRequest } from 'next/server';
import { ModelProviderProbeRequest, ModelProviderProbeResult } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { probeProvider } from '@/lib/api/services/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ providerId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { providerId } = await ctx.params;
    // 请求体可为空（表示「用库里已存的配置去测」），见契约注释。
    const body = ModelProviderProbeRequest.parse(await readJson(req));
    const result = await probeProvider(providerId, body);
    return ok(ModelProviderProbeResult, result);
  });
}
