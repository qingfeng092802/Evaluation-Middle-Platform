/**
 * `GET /api/baselines/resolution` · 某评测集的基线解析（`PG-08` 消费）。
 *
 * `confirmed=null` 是**一等状态**而非错误（契约注释原文）：PG-08 必须据此渲染
 * 「尚未确认基线，本次对比仅供观察，不作为门禁依据」横幅（`BL-2`）。
 * 评测集不存在 → 404（与 `providers/{id}` 等详情路由同一约定）。
 */
import type { NextRequest } from 'next/server';
import { BaselineResolution, Uuid } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { resolveBaseline } from '@/lib/api/services/baselines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const datasetId = Uuid.parse(req.nextUrl.searchParams.get('datasetId'));
    return ok(BaselineResolution, await resolveBaseline(datasetId));
  });
}
