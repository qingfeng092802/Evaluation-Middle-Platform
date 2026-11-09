/**
 * `GET /api/runs/preflight`（`PG-01` 依赖横幅 / `PG-02` 步骤 3）。
 *
 * 查询串里带 `evaluatorKeys`（逗号分隔）。**不传该参数时按「已选检索算子」处理**？
 * 不 —— 不传就是「还没选」，此时不应因为缺标注而阻断。
 * 因此缺省为空数组，三条阻塞里只有凭证那条可能命中。
 */
import type { NextRequest } from 'next/server';
import { RunPreflight } from '@eval-platform/contracts';
import { BadRequestError, handle, ok } from '@/lib/api/http';
import { csvList } from '@/lib/api/paging';
import { preflight } from '@/lib/api/services/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const url = new URL(req.url);
    const datasetVersionId = url.searchParams.get('datasetVersionId');
    if (!datasetVersionId) throw new BadRequestError('缺少 datasetVersionId');
    const evaluatorKeys = csvList(url.searchParams.get('evaluatorKeys'));
    return ok(RunPreflight, await preflight({ datasetVersionId, evaluatorKeys }));
  });
}
