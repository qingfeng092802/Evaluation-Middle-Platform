/**
 * `GET /api/runs/{runId}/cases/{caseKey}`（`PG-04` 抽屉）。
 *
 * 返回 `CaseDetailResponse`：本 run 结果 + 版本内原始 Case + 基线侧结果。
 * 没有基线时 `hasBaseline=false`、`baselineResult=null`——
 * 前端据此渲染「无基线」而不是把缺失当 0 分做差。
 */
import type { NextRequest } from 'next/server';
import { CaseDetailResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { getCaseDetailOrThrow } from '@/lib/api/services/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ runId: string; caseKey: string }> },
): Promise<Response> {
  return handle(async () => {
    const { runId, caseKey } = await ctx.params;
    return ok(CaseDetailResponse, await getCaseDetailOrThrow(runId, decodeURIComponent(caseKey)));
  });
}
