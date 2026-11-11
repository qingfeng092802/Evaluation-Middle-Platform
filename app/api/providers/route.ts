/**
 * `GET /api/providers`（`PG-06` T1 表单的「模型」下拉 / `PG-02` 步骤 2）。
 *
 * 只读，且**只回可回传视图**：`listProviderViews()` 刻意不 select `api_key_ciphertext`，
 * 因此「忘记脱敏」在类型层面就不可能发生（`工程规则` §9）。
 *
 * 为什么 M1 就需要它：`TargetCreate.config.modelProviderId` 必填。没有列表接口，
 * 前端只能写死一个 UUID —— 那正是本 SPEC 明令禁止的「写死数据冒充联调」。
 *
 * 创建 / 更新厂商（`PG-09`）是 P1，本文件不提供 POST。
 */
import type { NextRequest } from 'next/server';
import { ModelProviderListResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { listProviders } from '@/lib/api/services/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest): Promise<Response> {
  return handle(async () => {
    const items = await listProviders();
    return ok(ModelProviderListResponse, { items, page: pageMeta(items.length) });
  });
}
