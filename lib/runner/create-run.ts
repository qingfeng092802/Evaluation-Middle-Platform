/**
 * 建 run 的服务层（`POST /api/runs` 的业务体，`[1]` 的全部动作）。
 *
 * 这里只编排，不写 SQL（SQL 在 `db/repo`），也不算分（算子在 `lib/operators`）。
 *
 * 三条阻塞校验在此**重跑**（R-6）：前端禁用按钮不构成保护。
 * 快照在此一次写入（R-11）：此后执行期只读 `config_snapshot`，不再回查模板表。
 */
import { EvalRunCreate } from '@eval-platform/contracts';
import { createRun } from '../../db/repo/evalRuns.js';
import { getVersionById, getRetrievalReadiness } from '../../db/repo/datasets.js';
import { getT1ExecutionConfig } from '../../db/repo/targets.js';
import { getEffectivePrice } from '../../db/repo/modelPrices.js';
import { hasActiveProvider, getProviderForExecution } from '../../db/repo/modelProviders.js';
import { toSnapshotEntry, type PriceSnapshotEntry } from '../cost/index.js';
import { evaluatePreflight, type BlockCode } from '../preflight/index.js';
import { RUNNER_VERSION } from './version.js';
import { createHash } from 'node:crypto';

export class BlockedError extends Error {
  constructor(
    readonly code: BlockCode,
    message: string,
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const APP_CREATED_BY = process.env['APP_CREATED_BY'] ?? 'm1-local';

/**
 * 创建 run。
 *
 * 顺序很重要：**先算快照再落库**。若先 INSERT 再查单价，一旦单价缺失就会留下
 * 一条 `config_snapshot` 不完整的 PENDING run，worker 领到后必然失败——
 * 那种失败对用户毫无解释力。
 */
export async function createEvalRun(rawBody: unknown): Promise<string> {
  const body = EvalRunCreate.parse(rawBody);

  const version = await getVersionById(body.datasetVersionId);
  if (!version) throw new NotFoundError('评测集版本不存在');

  const target = await getT1ExecutionConfig(body.targetVersionId);
  if (!target) throw new NotFoundError('待测目标版本不存在或不是 T1 类型');

  const evaluatorKeys = body.evaluators.map((e) => e.config.key);
  const readiness = await getRetrievalReadiness(body.datasetVersionId);

  // ---- 三条阻塞（R-6 / R-7）----
  const hasProviderCredentials = await hasActiveProvider();
  const preflight = evaluatePreflight({
    hasProviderCredentials,
    evaluatorKeys,
    retrievalReadiness: readiness,
  });
  if (!preflight.canStart) {
    const first = preflight.blockers[0] as BlockCode;
    throw new BlockedError(first, '前置校验未通过');
  }

  // ---- 单价快照（R-11）----
  const price = await getEffectivePrice(target.modelProviderId, target.modelId);
  const priceSnapshot: PriceSnapshotEntry[] = price ? [toSnapshotEntry(price)] : [];

  const provider = await getProviderForExecution(target.modelProviderId);
  if (!provider) throw new BlockedError('BLOCKED_NO_PROVIDER_CREDENTIALS', '厂商不可用');

  // ---- 快照（R-11）----
  const configSnapshot = {
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
    targetVersionId: body.targetVersionId,
    targetKind: 't1_prompt' as const,
    evaluators: body.evaluators.map((e) => ({
      config: e.config,
      weight: e.weight,
      ...(e.passThreshold === undefined ? {} : { passThreshold: e.passThreshold }),
    })),
    priceSnapshot,
  };

  const reproducibility = {
    temperature: target.temperature,
    topP: null,
    maxTokens: target.maxTokens,
    seed: null,
    runnerVersion: RUNNER_VERSION,
    modelVersionString: null,
    promptTemplateHash: createHash('sha256').update(target.promptTemplate, 'utf8').digest('hex'),
    cachePolicy: 'none' as const,
  };

  const runId = await createRun({
    name: body.name,
    datasetVersionId: body.datasetVersionId,
    targetVersionId: body.targetVersionId,
    concurrency: body.concurrency,
    totalCases: version.caseCount,
    configSnapshot,
    reproducibility,
    runnerVersion: RUNNER_VERSION,
    triggerSource: body.triggerSource,
    ...(body.baselineRunId === undefined ? {} : { baselineRunId: body.baselineRunId }),
    createdBy: APP_CREATED_BY,
    evaluators: body.evaluators.map((e) => ({
      evaluatorKey: e.config.key,
      evaluatorVersion: 1,
      kind: e.config.key === 'judge' ? ('judge' as const) : ('rule' as const),
      config: e.config,
      weight: e.weight,
      passThreshold: e.passThreshold ?? null,
    })),
  });

  return runId;
}

export { APP_CREATED_BY };
