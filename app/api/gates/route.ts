/**
 * `GET /api/gates` · `POST /api/gates`（`PG-09`「门禁规则」Tab，`US-017`）。
 *
 * 契约已有（`RegressionGateCreate/Update/Gate` + openapi `/api/gates*`），
 * 本路由只做搬运；判定语义见 `lib/api/services/gates.ts`。
 */
import type { NextRequest } from 'next/server';
import { RegressionGate, RegressionGateListResponse } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { createGate, listGates } from '@/lib/api/services/gates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    return ok(RegressionGateListResponse, await listGates(req.nextUrl.searchParams.get('datasetId')));
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    return ok(RegressionGate, await createGate(await readJson(req)), 201);
  });
}
