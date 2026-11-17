/**
 * `POST /api/baselines/{baselineId}/decision` · 确认 / 驳回（`US-020`，仅 ROLE-B）。
 *
 * ## 角色约定（需求方 2026-11-15 裁定 1）
 * MVP 阶段角色由 **`X-Role: A|B` 请求头模拟（缺省 `A`）**；本路由**仅 ROLE-B**，
 * 非 B（含缺头）→ 403 `FORBIDDEN`。提名（ROLE-A）不经过本路由。
 *
 * ## 流转与冲突（数据库当裁判，仓储/路由层不重复实现）
 * - `trg_baselines_guard`（0016）：已裁定（CONFIRMED/REJECTED）的行不可 re-decide，
 *   触发器 RAISE 由 `handle()` 统一翻译成 409 `IMMUTABLE_VIOLATION`；
 * - 确认时同集已有 CONFIRMED → `ux_baselines_one_confirmed` 唯一冲突 →
 *   409 `CONFLICT`（双基线拦截，`BL-1`）；
 * - `note` 语义（裁定 2）：payload 携带 `note` 则覆盖，未携带则保留提名理由；
 * - 基线不存在 → 404（openapi 响应清单未穷举，与 `providers/{id}` 等详情路由同约定）。
 */
import type { NextRequest } from 'next/server';
import { Baseline } from '@eval-platform/contracts';
import { ForbiddenError, handle, ok, readJson } from '@/lib/api/http';
import { decideBaseline } from '@/lib/api/services/baselines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ baselineId: string }> },
): Promise<Response> {
  return handle(async () => {
    // MVP 阶段角色模拟：缺省即 ROLE-A，只有显式 `X-Role: B` 才放行（裁定 1）
    if ((req.headers.get('x-role') ?? 'A').toUpperCase() !== 'B') {
      throw new ForbiddenError('确认 / 驳回仅 ROLE-B 可用（X-Role: B）');
    }
    const { baselineId } = await ctx.params;
    return ok(Baseline, await decideBaseline(baselineId, await readJson(req)));
  });
}
