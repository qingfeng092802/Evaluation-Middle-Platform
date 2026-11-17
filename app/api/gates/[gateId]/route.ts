/**
 * `PATCH /api/gates/{gateId}` —— 更新门禁规则（`US-017`，契约 openapi `/api/gates/{gateId}`）。
 *
 * `regression_gates` 可编辑（审计留痕拆在 `gate_evaluations`，§2.13 裁定）；
 * 不存在 ⇒ 服务层抛 `NotFoundError` ⇒ 404。
 */
import type { NextRequest } from 'next/server';
import { RegressionGate } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { updateGate } from '@/lib/api/services/gates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ gateId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { gateId } = await ctx.params;
    return ok(RegressionGate, await updateGate(gateId, await readJson(req)));
  });
}
