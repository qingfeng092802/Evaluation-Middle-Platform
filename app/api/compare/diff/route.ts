/**
 * `GET /api/compare/diff` · 双版本 AB Diff 聚合（`PG-08` / `PG-04` 抽屉数据面）。
 *
 * 与 `/api/compare` 共用同一服务核（`RunComparisonDiffResponse` 是 `CompareResponse`
 * 的契约级扩展）。硬拒绝走契约 `describeIncomparable()`，非空 → **400**
 * （openapi「否则返回 400」，不用 409）；拿不到一侧分数判 NOT_COMPARABLE，
 * **不得当 0 分处理**。
 */
import type { NextRequest } from 'next/server';
import { RunComparisonDiffResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { compareRunsDiff } from '@/lib/api/services/compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    return ok(RunComparisonDiffResponse, await compareRunsDiff(req.nextUrl.searchParams));
  });
}
