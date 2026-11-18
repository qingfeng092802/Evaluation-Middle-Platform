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
import { randomBytes, createHash } from 'node:crypto';
import {
  RegressionGateCreate,
  RegressionGateUpdate,
  Uuid,
  deriveGateOverall,
} from '@eval-platform/contracts';
import type {
  GateChannel,
  GateCondition,
  GateEvaluationDetail,
  GateResultEnvelope,
  OutboundDispatchLog,
  RegressionGate,
} from '@eval-platform/contracts';
import type { CallbackTokenResponse } from '@eval-platform/contracts';
import { getRun } from '../../../db/repo/evalRuns.js';
import { getConfirmedBaselineRunId } from '../../../db/repo/compare.js';
import {
  createCallbackToken,
  createGate as repoCreateGate,
  findActiveCallbackToken,
  gateExists,
  getDatasetIdForRun,
  getGateRow,
  getVersionContext,
  hasEvaluation,
  insertGateEvaluation,
  insertOutboundDispatchLog,
  listActiveGatesForDatasetVersion,
  listEvaluationsByRun,
  listGatesByDataset,
  listOutboundDispatchLogs,
  updateGate as repoUpdateGate,
} from '../../../db/repo/gates.js';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../http.js';
import { getBaselineRow } from '../../../db/repo/baselines.js';

/** MVP 单机标识（与 `baselines` 服务同口径；OUT-4 不做用户体系）。 */
const LOCAL_ACTOR = 'local';

/** 固定历史基线的写入侧校验：pin 必须存在且属于同一评测集（脏配置挡在写入侧）。 */
async function assertPinnableBaseline(baselineId: string, datasetId: string): Promise<void> {
  const row = await getBaselineRow(baselineId);
  if (row === null) throw new NotFoundError('固定的历史基线不存在');
  if (row.datasetId !== datasetId) {
    throw new BadRequestError('baselineId 与评测集不匹配（跨集 pin 会把别的评测集的锚点偷过来）', {
      baselineId,
      gateDatasetId: datasetId,
      baselineDatasetId: row.datasetId,
    });
  }
}

export async function createGate(raw: unknown): Promise<RegressionGate> {
  const input = RegressionGateCreate.parse(raw);
  if (input.baselineId !== undefined && input.baselineId !== null) {
    await assertPinnableBaseline(input.baselineId, input.datasetId);
  }
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
    baselineId?: string | null;
  } = {};
  if (patchInput.name !== undefined) patch.name = patchInput.name;
  if (patchInput.condition !== undefined) patch.condition = patchInput.condition;
  if (patchInput.action !== undefined) patch.action = patchInput.action;
  if (patchInput.isActive !== undefined) patch.isActive = patchInput.isActive;
  if (patchInput.channels !== undefined) patch.channels = patchInput.channels;
  if (patchInput.baselineId !== undefined) {
    // `null` = 清除 pin（回到「用当前已确认基线」）；非 null = 换锚，仍要过写入侧校验
    if (patchInput.baselineId !== null) {
      const gate = await getGateRow(gateId);
      if (gate === null) throw new NotFoundError('门禁规则不存在');
      await assertPinnableBaseline(patchInput.baselineId, gate.datasetId);
    }
    patch.baselineId = patchInput.baselineId;
  }
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
 * 签发 CI 回调 Token（明文仅返回一次；平台只存 SHA-256 哈希）。
 * MVP 口径：expiresAt=null（不过期）。
 */
export async function registerCallbackToken(gateIdRaw: string): Promise<CallbackTokenResponse> {
  const gateId = Uuid.parse(gateIdRaw);
  const gate = await getGateRow(gateId);
  if (gate === null) throw new NotFoundError('门禁规则不存在');
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await createCallbackToken({ gateId, tokenHash, createdBy: LOCAL_ACTOR });
  return { token, expiresAt: null };
}

/**
 * 拉取鉴权：`X-Callback-Token` 头的值 → SHA-256 → 反查明细；
 * Token 绑定其门禁的评测集——跨评测集使用视为越权（401）。
 *
 * 顺序即语义：缺失/无效 Token 一律 401（不暴露 run 存在性）；
 * 合法 Token + 未知 run ⇒ 404（持有效凭证者值得精确诊断）；
 * 合法 Token + 跨评测集 run ⇒ 401（越权）。
 */
export async function verifyCallbackTokenForRun(
  token: string | null,
  runId: string,
): Promise<void> {
  if (token === null || token === '') throw new UnauthorizedError('回调 Token 缺失');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = await findActiveCallbackToken(tokenHash);
  if (row === null) throw new UnauthorizedError('回调 Token 无效或已过期');
  const datasetId = await getDatasetIdForRun(runId);
  if (datasetId === null) throw new NotFoundError('运行不存在');
  if (row.datasetId !== datasetId) {
    throw new UnauthorizedError('回调 Token 与目标评测集不匹配');
  }
}

// ---------------------------------------------------------------------------
// 出站派发（US-018：评测结束后把结论推送到配置的渠道）
// ---------------------------------------------------------------------------

export interface GateDispatchSummary {
  gateId: string;
  gateName: string;
  overall: string;
  evalRunId: string;
  runName: string;
}

/**
 * 出站派发：逐 channel POST 其形状的载荷；失败告警**并落留痕**（0021），
 * 不阻塞主流程（渠道不可达是常态）。
 *
 * 留痕语义（0021 `outbound_dispatch_logs`，只追加）：
 *  - SUCCESS / FAILED **都落行**——只记失败会让「到底发没发出去」不可问；
 *  - `fetch` 对 HTTP 非 2xx **不抛错**，必须显式判 `res.ok`，否则渠道端 4xx/5xx
 *    会被静默当成成功；
 *  - 留痕写入失败只告警（审计通道自身故障不能反过来拖垮派发）；
 *  - `retryCount` 恒为 0：无自动重试引擎，重试上线后以新增行记录（不编造语义）。
 */
export async function dispatchGateResult(channels: GateChannel[], summary: GateDispatchSummary): Promise<void> {
  for (const ch of channels) {
    const body =
      ch.kind === 'feishu'
        ? { msg_type: 'text', content: { text: `【评测门禁】${summary.runName} 判定 ${summary.overall}（${summary.gateName}）` } }
        : ch.kind === 'wecom'
          ? { msgtype: 'markdown', markdown: { content: `**评测门禁** ${summary.runName}：${summary.overall}（${summary.gateName}）` } }
          : summary;
    let status: 'SUCCESS' | 'FAILED';
    let errorMessage: string | null = null;
    try {
      const res = await fetch(ch.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        status = 'SUCCESS';
      } else {
        status = 'FAILED';
        errorMessage = `HTTP ${res.status}`;
      }
    } catch (err) {
      status = 'FAILED';
      errorMessage = (err as Error).message;
      console.warn(`[gates] 出站派发失败（${ch.kind} ${ch.url}）：`, errorMessage);
    }
    try {
      await insertOutboundDispatchLog({
        gateId: summary.gateId,
        evalRunId: summary.evalRunId,
        channelKind: ch.kind,
        channelUrl: ch.url,
        payload: body,
        status,
        errorMessage,
      });
    } catch (logErr) {
      console.warn(`[gates] 派发留痕写入失败（${ch.kind} ${ch.url}）：`, (logErr as Error).message);
    }
  }
}

/** 派发历史（`GET /api/gates/{gateId}/dispatch-logs`，0021）；gate 不存在 → 404。 */
export async function listDispatchLogs(
  gateIdRaw: string | null,
): Promise<{ items: OutboundDispatchLog[]; page: { nextCursor: null; total: number } }> {
  const gateId = Uuid.parse(gateIdRaw);
  if (!(await gateExists(gateId))) throw new NotFoundError('门禁规则不存在');
  const items = await listOutboundDispatchLogs(gateId);
  return { items, page: { nextCursor: null, total: items.length } };
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

  const insertedGates: Array<{ id: string; channels: GateChannel[]; name: string }> = [];
  for (const gate of gates) {
    if (await hasEvaluation(gate.id, runId)) continue; // 幂等：留痕已在，跳过

    // 逐规则锚点（契约注释：「null = 用当前已确认基线；非 null = 固定到某次历史基线」）：
    //  - 无 pin ⇒ 已确认基线 run（BL-2 唯一锚点）；
    //  - 有 pin ⇒ 它固定的那条 baselines 行的 eval_run_id；
    //  - pin 行不存在 / REJECTED / 跨评测集 / 锚 run 缺失 ⇒ 跳过（不判定不留痕，
    //    与「无已确认基线」同一 fail-closed 语义——跳过不等于通过）。
    let anchorRun = confirmedRun;
    if (gate.baselineId !== null) {
      const pinned = await getBaselineRow(gate.baselineId);
      if (pinned === null || pinned.status === 'REJECTED' || pinned.datasetId !== gate.datasetId) continue;
      anchorRun = await getRun(pinned.evalRunId);
      if (anchorRun === null) continue;
    }

    // regression_pct 需要锚点 run；无锚点 ⇒ 跳过（不判定不留痕）
    if (gate.condition.metric === 'regression_pct' && anchorRun === null) continue;
    const gateBaseline =
      anchorRun !== null
        ? { scoreOverall: anchorRun.metrics.scoreOverall, passRate: anchorRun.metrics.passRate }
        : null;
    const evalResult = evaluateCondition(gate.condition, current, gateBaseline);
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
    insertedGates.push({ id: gate.id, channels: gate.channels, name: gate.name });
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

  // US-018 出站派发：仅对本轮**新判定**的规则推送其 channels（幂等拉取不重复打扰渠道）。
  // 渠道不可达只告警不阻塞（dispatchGateResult 内部吞错）；阻塞语义由 CI 侧拉取 overall 决定。
  for (const g of insertedGates) {
    await dispatchGateResult(g.channels, {
      gateId: g.id,
      gateName: g.name,
      overall,
      evalRunId: runId,
      runName: run.name,
    });
  }

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
