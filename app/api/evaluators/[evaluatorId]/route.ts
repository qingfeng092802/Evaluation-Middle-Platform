/**
 * `PATCH /api/evaluators/{evaluatorId}` —— 更新裁判模板（PG-07，`US-016`）。
 *
 * `config` 变更 ⇒ 模板 `version + 1`（default_config / prompt_template 同步）；
 * `displayName` / `description` 变更不动版本。已快照进 `run_evaluators` 的历史
 * 运行不受影响（PT-1——快照表不可变）。内置合成清单项无 DB 行 ⇒ 404。
 */
import type { NextRequest } from 'next/server';
import { EvaluatorTemplate } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { updateEvaluatorTemplate } from '@/lib/api/services/evaluators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ evaluatorId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { evaluatorId } = await ctx.params;
    return ok(EvaluatorTemplate, await updateEvaluatorTemplate(evaluatorId, await readJson(req)));
  });
}
