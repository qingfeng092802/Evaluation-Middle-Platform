/**
 * `POST /api/datasets/imports/validate`（`PG-05` 上传面板）。
 *
 * 解析与逐行校验都在服务端做一次，前端只渲染结果 —— 两处各写一套必然会慢慢漂移，
 * 而「通过 49 条 / 失败 1 条」这种数字一旦对不上，用户就没法信任这个页面。
 *
 * 行号口径（D-11）：JSONL 用物理行号；CSV **表头计入物理行号**（AC-3 的 47 / 48）。
 */
import type { NextRequest } from 'next/server';
import { DatasetImportValidate, ImportValidationReport } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { assertNonEmpty, validateImport } from '@/lib/api/services/datasets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const body = DatasetImportValidate.parse(await readJson(req));
    assertNonEmpty(body.content);
    const { report } = validateImport(body);
    return ok(ImportValidationReport, report);
  });
}
