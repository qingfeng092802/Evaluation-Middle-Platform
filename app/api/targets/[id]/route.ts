/**
 * `GET /api/targets/{id}` · `PATCH /api/targets/{id}`（`PG-06`）。
 *
 * PATCH 语义（PG-06 原文「保存后将生成 v2，历史运行仍引用 v1」）：
 * `config` 有变化才推版本号；只改名称时 `newVersionNo` 为 `null`。
 * 两个字段都在响应里，前端不必靠猜来决定要不要弹版本提示。
 */
import type { NextRequest } from 'next/server';
import { Target } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { getTargetOrThrow, updateTarget } from '@/lib/api/services/targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return ok(Target, await getTargetOrThrow(id));
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const { target } = await updateTarget(id, await readJson(req));
    return ok(Target, target);
  });
}
