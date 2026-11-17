/**
 * 门禁规则与判定引擎（M4 Batch 2，`US-017` 数据面）。
 *
 * ## 判定语义（fail-closed，与 OPEN-5 / BL-2 一致）
 *
 *  - 触发判定：`op '<'` ⇒ 指标值 < 阈值；`op '>'` ⇒ 指标值 > 阈值；
 *  - 指标值为 null（FAILED run / 未设阈值 / 缺确认基线）⇒ **passed=false（不放行）**，
 *    detail 中 currentValue=null——绝不落 0 分；
 *  - `regression_pct` 相对**已确认基线**（`BL-2` 唯一锚点）；基线分数为 0 或 null
 *    ⇒ 退化率记 null ⇒ passed=false；
 *  - 无已确认基线时 `regression_pct` 规则**整体跳过**（不判定、不留痕），
 *    envelope.baseline=null 如实注明；
 *  - `WARN` 触发 ⇒ 留痕 passed=false 但 `overall=PASS`（`deriveGateOverall` 复用契约）。
 *
 * ## 幂等与留痕
 * 同 (gate, run) 已有留痕时跳过插入、复用既有行（0014 无唯一约束，查重是唯一
 * 防线）；留痕不可变（`reject_mutation()`），第二次求值只读不改。
 *
 * ## 身份
 * `created_by` 写 MVP 单机标识 `'local'`（与 `baselines` 服务同口径，OUT-4）。
 */
import {
  RegressionGateCreate,
  RegressionGateUpdate,
  Uuid,
  deriveGateOverall,
} from '@eval-platform/contracts';
import type {
  GateCondition,
  GateEvaluationDetail,
  GateResultEnvelope,
  RegressionGate,
} from '@eval-platform/contracts';
import { getRun } from '../../../db/repo/evalRuns.js';
import { getConfirmedBaselineRunId } from '../../../db/repo/compare.js';
import {
  createGate as repoCreateGate,
  getVersionContext,
  hasEvaluation,
  insertGateEvaluation,
  listActiveGatesForDatasetVersion,
  listEvaluationsByRun,
  listGatesByDataset,
  updateGate as repoUpdateGate,
} from '../../../db/repo/gates.js';
import { ConflictError, NotFoundError } from '../http.js';

/** MVP 单机标识（与 `baselines` 服务同口径；OUT-4 不做用户体系）。 */
const LOCAL_ACTOR = 'local';

export async function createGate(raw: unknown): Promise<RegressionGate> {
  const input = RegressionGateCreate.parse(raw);
  return repoCreateGate({
    name: input.name,
    datasetId: input.datasetId,
    targetId: input.targetId ?? null,
    baselineId: input.baselineId ?? null,
    condition: input.condition,
    action: input.action,
    channels: input.channels,
    createdBy: LOCAL_ACTOR,
  });
}

export async function listGates(
  datasetIdRaw: string | null,
): Promise<{ items: RegressionGate[]; page: { nextCursor: null; total: number } }> {
  const datasetId = Uuid.parse(datasetIdRaw);
  const items = await listGatesByDataset(datasetId);
  return { items, page: { nextCursor: null, total: items.length } };
}

export async function updateGate(gateIdRaw: string, raw: unknown): Promise<RegressionGate> {
  const gateId = Uuid.parse(gateIdRaw);
  const patchInput = RegressionGateUpdate.parse(raw);
  const patch: {
    name?: string;
    condition?: unknown;
    action?: string;
    isActive?: boolean;
    channels?: unknown[];
  } = {};
  if (patchInput.name !== undefined) patch.name = patchInput.name;
  if (patchInput.condition !== undefined) patch.condition = patchInput.condition;
  if (patchInput.action !== undefined) patch.action = patchInput.action;
  if (patchInput.isActive !== undefined) patch.isActive = patchInput.isActive;
  if (patchInput.channels !== undefined) patch.channels = patchInput.channels;
  const updated = await repoUpdateGate(gateId, patch);
  if (updated === null) throw new NotFoundError('门禁规则不存在');
  return updated;
}

interface RunMetricsLite {
  scoreOverall: number | null;
  passRate: number | null;
}

/**
 * 单条规则求值：返回留痕入参与「是否触发」。
 * `metricVal = null`（指标缺失）⇒ fail-closed 视为触发（不放行）。
 */
function evaluateCondition(
  condition: GateCondition,
  current: RunMetricsLite,
  baseline: RunMetricsLite | null,
): { passed: boolean; triggered: boolean; detail: GateEvaluationDetail } {
  const cond = condition;
  let baselineValue: number | null = null;
  let currentValue: number | null = null;
  let metricVal: number | null = null;
  let delta: number | null = null;

  if (cond.metric === 'regression_pct') {
    if (baseline !== null) baselineValue = baseline.scoreOverall;
    currentValue = current.scoreOverall;
    // 退化百分点 = (基线 − 当前) / 基线 × 100；基线缺失/为 0 ⇒ null（不放行）
    metricVal =
      baselineValue !== null && baselineValue > 0 && currentValue !== null
        ? ((baselineValue - currentValue) / baselineValue) * 100
        : null;
    delta = metricVal;
  } else {
    metricVal = cond.metric === 'score_overall' ? current.scoreOverall : current.passRate;
    if (baseline !== null) {
      baselineValue = cond.metric === 'score_overall' ? baseline.scoreOverall : baseline.passRate;
    }
    delta = baselineValue !== null && metricVal !== null ? metricVal - baselineValue : null;
    currentValue = metricVal;
  }

  const triggered = metricVal === null ? true : cond.op === '<' ? metricVal < cond.value : metricVal > cond.value;

  return {
    passed: !triggered,
    triggered,
    detail: {
      metric: cond.metric,
      baselineValue,
      currentValue,
      delta,
      op: cond.op,
      value: cond.value,
    },
  };
}

/**
 * 跑批终态 → 逐规则求值 → 留痕 → 信封组装（`GateResultEnvelope` 契约，形状逐字）。
 *
 * 幂等：同 (gate, run) 已有留痕时跳过插入、复用既有行；envelope 从留痕表回读，
 * 保证「库里有几行、信封就几条」。
 */
export async function evaluateRunGates(runIdRaw: string): Promise<GateResultEnvelope> {
  const runId = Uuid.parse(runIdRaw);
  const run = await getRun(runId);
  if (!run) throw new NotFoundError('运行不存在');
  if (run.status === 'PENDING' || run.status === 'RUNNING') {
    throw new ConflictError('跑批未到终态，无法判定门禁');
  }

  const gates = await listActiveGatesForDatasetVersion(run.datasetVersionId);
  const confirmedRunId = await getConfirmedBaselineRunId(run.datasetVersionId);
  const confirmedRun = confirmedRunId !== null ? await getRun(confirmedRunId) : null;

  const current = { scoreOverall: run.metrics.scoreOverall, passRate: run.metrics.passRate };
  const baseline = confirmedRun
    ? { scoreOverall: confirmedRun.metrics.scoreOverall, passRate: confirmedRun.metrics.passRate }
    : null;

  for (const gate of gates) {
    if (await hasEvaluation(gate.id, runId)) continue; // 幂等：留痕已在，跳过

    // regression_pct 需要已确认基线 run；无确认基线 ⇒ 跳过（不判定不留痕）
    if (gate.condition.metric === 'regression_pct' && confirmedRun === null) continue;
    // 固定历史基线（gate.baselineId 指向历史基线行）属 Batch 4 扩展，本批跳过
    if (gate.baselineId !== null) continue;

    const evalResult = evaluateCondition(gate.condition, current, baseline);
    await insertGateEvaluation({
      gateId: gate.id,
      evalRunId: runId,
      passed: evalResult.passed,
      metric: evalResult.detail.metric,
      baselineValue: evalResult.detail.baselineValue,
      currentValue: evalResult.detail.currentValue,
      delta: evalResult.detail.delta,
      op: evalResult.detail.op,
      value: evalResult.detail.value,
    });
  }

  // envelope 从留痕表回读（库里有几行、信封就几条；只含本版本评测集的启用规则）
  const persisted = await listEvaluationsByRun(runId);
  const gateById = new Map(gates.map((g) => [g.id, g] as const));
  const evaluations = persisted
    .filter((r) => gateById.has(r.gateId))
    .map((r) => {
      const gate = gateById.get(r.gateId);
      return {
        gateId: r.gateId,
        gateName: gate?.name ?? '',
        action: gate?.action ?? ('BLOCK' as const),
        passed: r.passed,
        detail: {
          metric: r.metric as GateEvaluationDetail['metric'],
          baselineValue: r.baselineValue,
          currentValue: r.currentValue,
          delta: r.delta,
          op: r.op as GateEvaluationDetail['op'],
          value: r.value,
        },
      };
    });

  const overall = deriveGateOverall(evaluations);
  const versionContext = await getVersionContext(run.datasetVersionId);

  return {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    evalRunId: run.id,
    runName: run.name,
    datasetId: versionContext?.datasetId ?? '',
    datasetVersionId: run.datasetVersionId,
    targetId: versionContext?.targetId ?? '',
    targetVersionId: run.targetVersionId,
    metrics: {
      scoreOverall: run.metrics.scoreOverall,
      passRate: run.metrics.passRate,
      coverage: run.metrics.coverage,
      costTotal: run.metrics.costTotal,
    },
    baseline:
      confirmedRun !== null
        ? {
            evalRunId: confirmedRun.id,
            scoreOverall: confirmedRun.metrics.scoreOverall,
            passRate: confirmedRun.metrics.passRate,
          }
        : null,
    evaluations,
    overall,
  };
}
