/**
 * 建 run 的服务层（`POST /api/runs` 的业务体，`[1]` 的全部动作）。
 *
 * 这里只编排，不写 SQL（SQL 在 `db/repo`），也不算分（算子在 `lib/operators`）。
 *
 * 三条阻塞校验在此**重跑**（R-6）：前端禁用按钮不构成保护。
 * 快照在此一次写入（R-11）：此后执行期只读 `config_snapshot`，不再回查模板表。
 */
import { EvalRunCreate } from '@eval-platform/contracts';
import type { EvaluatorConfig } from '@eval-platform/contracts';
import { createRun } from '../../db/repo/evalRuns.js';
import { getVersionById, getRetrievalReadiness } from '../../db/repo/datasets.js';
import { resolveTargetExecution } from '../../db/repo/targets.js';
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

  const target = await resolveTargetExecution(body.targetVersionId);
  if (!target) throw new NotFoundError('待测目标版本不存在');

  const evaluatorKeys = body.evaluators.map((e) => e.config.key);
  const readiness = await getRetrievalReadiness(body.datasetVersionId);
  const hasJudge = evaluatorKeys.includes('judge');

  // ---- 三条阻塞（R-6 / R-7）----
  // BLOCKED_NO_PROVIDER_CREDENTIALS 的存在意义是「跑批必须打到 LLM 网关」。
  // T2 目标直连被测端点，**无裁判算子时不经过任何网关**——此时没有启用厂商
  // 不构成阻塞（US-021 的意义正在于此：评已部署应用不需要平台持有模型 Key）。
  const needsGateway = target.kind === 't1_prompt' || hasJudge;
  const hasProviderCredentials = needsGateway ? await hasActiveProvider() : true;
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
  //
  // **目标模型与裁判模型都要进快照**。裁判成本单独入账（`OPEN-3` 的 `cost_judge`），
  // 而执行期只允许读快照（R-11，不允许回查 `model_prices`）。若这里只快照目标模型，
  // 裁判那边就查不到价，只能记 0 —— 等于把裁判开销从账上抹掉。
  // T2 目标没有 (厂商, 模型) 可查价：成本由端点上报（US-021），不快照目标价。
  const priceEntries: PriceSnapshotEntry[] = [];
  if (target.kind === 't1_prompt') {
    const targetPrice = await getEffectivePrice(target.modelProviderId, target.modelId);
    if (targetPrice) priceEntries.push(toSnapshotEntry(targetPrice));
  }

  const judgeConfigs = body.evaluators
    .map((e) => e.config)
    .filter((c): c is Extract<EvaluatorConfig, { key: 'judge' }> => c.key === 'judge');

  for (const jc of judgeConfigs) {
    // 同一裁判 (厂商, 模型) 只快照一次
    const already = priceEntries.some(
      (p) => p.modelProviderId === jc.modelProviderId && p.modelId === jc.modelId,
    );
    if (already) continue;
    const jp = await getEffectivePrice(jc.modelProviderId, jc.modelId);
    // 没配价就不进快照：执行期同样记 0，但至少**不会**错用目标模型的价。
    if (jp) priceEntries.push(toSnapshotEntry(jp));
  }

  const priceSnapshot = priceEntries;

  if (target.kind === 't1_prompt') {
    const provider = await getProviderForExecution(target.modelProviderId);
    if (!provider) throw new BlockedError('BLOCKED_NO_PROVIDER_CREDENTIALS', '厂商不可用');
  }

  // ---- 快照（R-11）----
  // T2 的 endpointUrl/mapping 进快照（可复现），authHeader 绝不进（US-021：
  // 密文列是唯一住所，快照会经 run detail API 读出）。
  const configSnapshot = {
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
    targetVersionId: body.targetVersionId,
    targetKind: target.kind,
    ...(target.kind === 't2_http'
      ? {
          targetEndpointUrl: target.endpointUrl,
          targetRequestMapping: target.requestMapping,
          targetResponseMapping: target.responseMapping,
          targetHasAuthHeader: target.authHeaderValue !== null,
        }
      : {}),
    evaluators: body.evaluators.map((e) => ({
      config: e.config,
      weight: e.weight,
      ...(e.passThreshold === undefined ? {} : { passThreshold: e.passThreshold }),
    })),
    priceSnapshot,
  };

  const reproducibility = {
    temperature: target.kind === 't1_prompt' ? target.temperature : null,
    topP: null,
    maxTokens: target.kind === 't1_prompt' ? target.maxTokens : null,
    seed: null,
    runnerVersion: RUNNER_VERSION,
    modelVersionString: null,
    promptTemplateHash:
      target.kind === 't1_prompt'
        ? createHash('sha256').update(target.promptTemplate, 'utf8').digest('hex')
        : createHash('sha256').update(target.endpointUrl, 'utf8').digest('hex'),
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
