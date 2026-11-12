/**
 * `GET /api/providers` · `POST /api/providers`（`PG-09`「模型网关」Tab，`US-015`）。
 *
 * GET 只回可回传视图：`listProviderViews()` 刻意不 select `api_key_ciphertext`，
 * 因此「忘记脱敏」在类型层面就不可能发生（`工程规则` §9）。
 *
 * POST 收明文 `apiKey`，加密后立即弃用；`ok(ModelProvider, …)` 会把响应再过一遍契约，
 * 谁往响应里塞了 Key 都会在这里炸，而不是在浏览器里悄悄泄露。
 */
import type { NextRequest } from 'next/server';
import { ModelProvider, ModelProviderListResponse } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { createProvider, listProviders } from '@/lib/api/services/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest): Promise<Response> {
  return handle(async () => {
    const items = await listProviders();
    return ok(ModelProviderListResponse, { items, page: pageMeta(items.length) });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    return ok(ModelProvider, await createProvider(await readJson(req)), 201);
  });
}
