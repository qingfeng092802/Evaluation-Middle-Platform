/**
 * `GET /api/runs/{runId}`（`PG-03` 报告页）。
 *
 * 含 `configSnapshot` / `reproducibility` / 算子快照 —— 这三样是
 * 「EvalRun 可解释，不可复现」在界面上的全部依据。
 */
import type { NextRequest } from 'next/server';
import { EvalRunDetail } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { getRunDetailOrThrow } from '@/lib/api/services/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { runId } = await ctx.params;
    return ok(EvalRunDetail, await getRunDetailOrThrow(runId));
  });
}
