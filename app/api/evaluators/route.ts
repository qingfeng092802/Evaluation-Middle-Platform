/**
 * `GET/POST /api/evaluators` —— 算子库清单与新建裁判模板（PG-07，`US-016`）。
 *
 * GET：内置六算子只读清单（合成）+ 已建裁判模板（入库）。
 * POST：只允许新建 `kind='judge'` 模板（契约限定）；key 撞内置/已有 ⇒ 409。
 */
import type { NextRequest } from 'next/server';
import { EvaluatorTemplate, EvaluatorTemplateListResponse } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { createEvaluatorTemplate, listEvaluatorTemplates } from '@/lib/api/services/evaluators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest): Promise<Response> {
  return handle(async () => ok(EvaluatorTemplateListResponse, await listEvaluatorTemplates()));
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () =>
    ok(EvaluatorTemplate, await createEvaluatorTemplate(await readJson(req)), 201),
  );
}
