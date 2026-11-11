/**
 * `GET /api/runs` · `POST /api/runs`（`PG-01` 列表 / `PG-02` 发起）。
 *
 * POST 在**同一事务**里写 `eval_runs` + `run_evaluators` 快照；三条阻塞校验
 * 由 `createEvalRun()` 重跑一遍（R-6：前端置灰按钮不构成保护）。
 */
import type { NextRequest } from 'next/server';
import {
  EvalRunDetail,
  EvalRunListQuery,
  EvalRunListResponse,
} from '@eval-platform/contracts';
import { handle, ok, parseQuery, readJson } from '@/lib/api/http';
import { pageMeta } from '@/lib/api/paging';
import { createRunAndLoad, listRunPage } from '@/lib/api/services/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const q = parseQuery(EvalRunListQuery, new URL(req.url));
    const items = await listRunPage({
      limit: q.limit,
      status: q.status,
      datasetId: q.datasetId,
      targetId: q.targetId,
    });
    return ok(EvalRunListResponse, { items, page: pageMeta(items.length) });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const detail = await createRunAndLoad(await readJson(req));
    return ok(EvalRunDetail, detail, 201);
  });
}
