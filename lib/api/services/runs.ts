/**
 * 运行服务层（`PG-01` / `PG-02` / `PG-03` / `PG-04`）。
 *
 * 这里只做编排与视图拼装；三条阻塞校验的真身在 `lib/preflight`（纯函数），
 * 建 run 的事务在 `lib/runner/create-run.ts` + `db/repo/evalRuns.ts`。
 *
 * `PG-04` 详情要拼三个来源：逐条结果（本 run）、Case 原始输入（所属版本，只读）、
 * 基线侧同 key 结果（可能没有）。**任一缺失都返回 null 而不是造 0 分**。
 */
import type {
  CaseDetailResponse,
  EvalCaseResult,
  EvalRun,
  EvalRunDetail,
  RunPreflight,
} from '@eval-platform/contracts';
import { EvalCaseResultListQuery, EvalRunCancel } from '@eval-platform/contracts';
import { getRun, getRunDetail, listRuns, requestCancel } from '../../../db/repo/evalRuns.js';
import { getResultByKey, listResults } from '../../../db/repo/evalCaseResults.js';
import { getCaseByKey, getRetrievalReadiness, getVersionById } from '../../../db/repo/datasets.js';
import { hasActiveProvider } from '../../../db/repo/modelProviders.js';
import { evaluatePreflight } from '../../preflight/index.js';
import { createEvalRun } from '../../runner/create-run.js';
import { NotFoundError } from '../http.js';

/** `PG-01` 横幅 / `PG-02` 步骤 3：三条依赖的当前状态。 */
export async function preflight(opts: {
  datasetVersionId: string;
  evaluatorKeys: readonly string[];
}): Promise<RunPreflight> {
  const version = await getVersionById(opts.datasetVersionId);
  if (!version) throw new NotFoundError('评测集版本不存在');

  const [hasProviderCredentials, readiness] = await Promise.all([
    hasActiveProvider(),
    getRetrievalReadiness(opts.datasetVersionId),
  ]);

  return evaluatePreflight({
    hasProviderCredentials,
    evaluatorKeys: opts.evaluatorKeys,
    retrievalReadiness: readiness,
  });
}

export async function listRunPage(opts: {
  limit: number;
  status?: string | undefined;
  datasetId?: string | undefined;
  targetId?: string | undefined;
}): Promise<EvalRun[]> {
  return listRuns(opts);
}

export async function getRunOrThrow(runId: string): Promise<EvalRun> {
  const run = await getRun(runId);
  if (!run) throw new NotFoundError('评测运行不存在');
  return run;
}

export async function getRunDetailOrThrow(runId: string): Promise<EvalRunDetail> {
  const detail = await getRunDetail(runId);
  if (!detail) throw new NotFoundError('评测运行不存在');
  return detail;
}

/** `POST /api/runs`：入队，返回建好的详情（状态 `PENDING`）。 */
export async function createRunAndLoad(raw: unknown): Promise<EvalRunDetail> {
  const runId = await createEvalRun(raw);
  return getRunDetailOrThrow(runId);
}

/**
 * 中止请求（`US-014`）：只置标记，不回写已完成结果。
 *
 * 状态机与「已被 worker 领走的 run」如何收尾由 `deriveTerminalStatus()` 决定，
 * 本层不臆断 —— 因此这里只落 `cancel_requested_at`。
 */
export async function cancelRun(runId: string, raw: unknown): Promise<EvalRunDetail> {
  EvalRunCancel.parse(raw ?? {});
  await getRunOrThrow(runId);
  const changed = await requestCancel(runId);
  if (!changed) {
    const run = await getRunOrThrow(runId);
    throw new NotFoundError(`运行当前状态 ${run.status} 不可中止`);
  }
  return getRunDetailOrThrow(runId);
}

export async function listRunCases(
  runId: string,
  url: URL,
): Promise<{ items: EvalCaseResult[]; limit: number }> {
  await getRunOrThrow(runId);
  const q = EvalCaseResultListQuery.parse(Object.fromEntries(url.searchParams.entries()));
  const items = await listResults({
    runId,
    limit: q.limit,
    sortBy: q.sortBy,
    order: q.order,
  });
  return { items, limit: q.limit };
}

/** `PG-04` 抽屉：本 run 结果 + 版本内原始 Case + 基线侧结果（可能没有）。 */
export async function getCaseDetailOrThrow(
  runId: string,
  caseKey: string,
): Promise<CaseDetailResponse> {
  const detail = await getRunDetailOrThrow(runId);
  const result = await getResultByKey(runId, caseKey);
  if (!result) throw new NotFoundError('该 Case 在本运行中尚无结果');

  const datasetCase = await getCaseByKey(detail.datasetVersionId, caseKey);
  if (!datasetCase) throw new NotFoundError('该 Case 在评测集版本中不存在');

  // 基线侧：M1 的对比对象是「同一 datasetVersion 的另一条 run」，
  // 逐条对齐靠 case_key（R-2 保证跨版本稳定）。
  const baselineRunId = detail.baselineRunId;
  const baselineResult =
    baselineRunId === null ? null : await getResultByKey(baselineRunId, caseKey);

  return {
    result,
    datasetCase,
    hasBaseline: baselineResult !== null,
    baselineResult,
  };
}

