/**
 * `POST /api/baselines` · 提名基线（`US-013`，`PG-01` / `PG-03` 行内入口）。
 * `GET  /api/baselines` · 基线列表 / 待确认提名（PG-09「基线确认」Tab 数据面；
 * openapi 已先行定义本路径与 `datasetId` / `status` 参数，本处为补位实现）。
 *
 * ## 角色约定（需求方 2026-11-15 裁定，MVP 阶段）
 * MVP 不引入登录鉴权（OUT-4），角色由 **`X-Role: A|B` 请求头模拟，缺省 `A`**。
 * 提名是 ROLE-A 能力，本路由因此**不做**角色拦截；确认 / 驳回
 * （`app/api/baselines/[baselineId]/decision/route.ts`）仅 ROLE-B，非 B 即 403。
 */
import type { NextRequest } from 'next/server';
import { Baseline, BaselineListQuery, BaselineListResponse } from '@eval-platform/contracts';
import { handle, ok, parseQuery, readJson } from '@/lib/api/http';
import { listBaselines, nominateBaseline } from '@/lib/api/services/baselines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const query = parseQuery(BaselineListQuery, new URL(req.url));
    return ok(BaselineListResponse, await listBaselines(query.datasetId, query.status ?? null));
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    return ok(Baseline, await nominateBaseline(await readJson(req)), 201);
  });
}
