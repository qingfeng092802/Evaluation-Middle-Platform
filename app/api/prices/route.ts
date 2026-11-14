/**
 * `GET /api/prices` · `POST /api/prices`（`PG-09` 单价配置区）。
 *
 * **成本口径的唯一事实源**（`TS-2` 红线）：本文件写进去的每一行都是钱的单价，
 * 成本只能由它算出。因此这里没有、也不会有任何来自上游网关的 `cost` / `usage` 字段。
 *
 * 动词与语义（契约 openapi:876 起）：
 *  - POST 只**增行**；`effectiveFrom` 区分调价时点，旧行永不被改；
 *  - GET 支持 `?modelProviderId=` 过滤。
 *
 * 查询串没有对应的契约 schema（契约只为 Dataset / EvalRun / EvalCaseResult 定义了
 * `*ListQuery`），所以这里的形状**就地**声明。它只做「可选 UUID」一件事，
 * 不复制任何业务规则，因此不会成为第二个事实源。
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ModelPrice, ModelPriceListResponse, Uuid } from '@eval-platform/contracts';
import { handle, ok, parseQuery, readJson } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { createPrice, listPricePage } from '@/lib/api/services/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 列表查询：全部可选，缺省即不带过滤。 */
const PriceListQuery = z.object({
  modelProviderId: Uuid.optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const q = parseQuery(PriceListQuery, new URL(req.url));
    const items = await listPricePage(q.modelProviderId);
    return ok(ModelPriceListResponse, { items, page: pageMeta(items.length) });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    // 契约校验在服务层（`createPrice` 里 `ModelPriceCreate.parse`），
    // 本文件只搬运，既不重复校验也不放宽。
    return ok(ModelPrice, await createPrice(await readJson(req)), 201);
  });
}
