/**
 * `POST /api/datasets/{id}/imports`（`PG-05` 区域 3「生成新版本」）。
 *
 * 入参是**文件原文**：解析与逐行校验必须在服务端做（`lib/import/` 只有一份实现），
 * 否则「第 47 行 / 第 48 行」的行号口径会在浏览器里长出第二份。
 *
 * 与 `/versions` 的分工：
 *  - `/versions` 收已解析好的 `cases`（CI / 程序化导入）；
 *  - `/imports` 收文件原文（人上传文件），服务端解析后走**同一条**落库路径。
 *
 * 只要有坏行就 400 且**一行都不写**：`details.issues` 原样带回逐行错误，
 * 前端直接渲染（仍然是服务端算好的物理行号，前端不做 ±1）。
 */
import type { NextRequest } from 'next/server';
import { DatasetVersionDetail } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { commitUploadedFile } from '@/lib/api/services/datasets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return ok(DatasetVersionDetail, await commitUploadedFile(id, await readJson(req)), 201);
  });
}
