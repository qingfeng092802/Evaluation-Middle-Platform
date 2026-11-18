/**
 * `GET /api/ledger` —— 成本台账（PG-10，`US-019` 四维 + fixture 排除）。
 *
 * 查询参数形状以 `CostLedgerQuery` 契约为准；响应逐字段过 `CostLedgerResponse.parse()`。
 */
import type { NextRequest } from 'next/server';
import { CostLedgerQuery, CostLedgerResponse } from '@eval-platform/contracts';
import { handle, ok, parseQuery } from '@/lib/api/http';
import { getLedger } from '@/lib/api/services/ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const query = parseQuery(CostLedgerQuery, new URL(req.url));
    return ok(CostLedgerResponse, await getLedger(query));
  });
}
