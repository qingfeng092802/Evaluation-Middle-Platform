/**
 * `GET /api/compare` · 汇总对比 + 逐条对比（`PG-08`，`US-009`）。
 *
 * 硬拒绝走契约 `describeIncomparable()`，非空 → **400**（openapi「否则返回 400」，
 * 不用 409）。`BL-2`：未使用已确认基线时响应携带 `baselineConfirmed=false` + 横幅。
 */
import type { NextRequest } from 'next/server';
import { CompareResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { compareRuns } from '@/lib/api/services/compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    return ok(CompareResponse, await compareRuns(req.nextUrl.searchParams));
  });
}
