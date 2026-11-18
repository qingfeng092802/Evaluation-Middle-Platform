/**
 * `GET /api/gates/results/{runId}` —— CI 拉取门禁结果（`US-018` 平台侧出口）。
 *
 * **平台对外只交付这一坨结构化 JSON**：不写 PR 评论、不持有 GitHub PAT、不知道
 * PR 号（`工程规则.md` §9，Q1=C 拉取模式裁定）。CI 侧拉取后自行决定如何评论/阻断。
 *
 * 惰性求值：首次拉取时对终态 run 逐启用规则求值并落 `gate_evaluations` 留痕
 * （不可变）；重复拉取幂等复用。`overall='NO_GATE'` 表示未配置任何规则，CI 不阻断。
 *
 * 鉴权（fail-closed）：请求必须携带 `X-Callback-Token` 头（签发于
 * `POST /api/gates/{gateId}/callback-token`，平台只存哈希）。Token 绑定其门禁
 * 所属评测集——跨评测集拉取一律 401（`UNAUTHORIZED`）。
 */
import type { NextRequest } from 'next/server';
import { GateResultResponse } from '@eval-platform/contracts';
import { handle, ok } from '@/lib/api/http';
import { evaluateRunGates, verifyCallbackTokenForRun } from '@/lib/api/services/gates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { runId } = await ctx.params;
    // 先鉴权后取数：Token 缺失/无效不暴露 run 存在性；合法 Token + 未知 run 仍走 404
    await verifyCallbackTokenForRun(req.headers.get('x-callback-token'), runId);
    return ok(GateResultResponse, { gateResult: await evaluateRunGates(runId) });
  });
}
