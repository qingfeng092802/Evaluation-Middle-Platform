/**
 * compare / diff 服务（M3 Batch 2，`US-009` / `US-010` / `US-011` 数据面）。
 *
 * ## 实现前提（需求方 2026-11-15 四项裁定 + 前提修正，正文见 SPEC-M3 §2 Batch 2）
 *
 * - **硬拒绝走契约函数**：`describeIncomparable()` 非空 → `BadRequestError`
 *   （400 VALIDATION_FAILED，openapi「否则返回 400」；**不用 409**）。维度穷举仅
 *   datasetVersionId 不同与同 run 自比——targetVersionId/算子集差异不硬拒。
 * - **deltaPct** = (current − baseline) / baseline；baseline 为 null 或 **0** → null
 *   （绝不出 Infinity/NaN，Q1）。
 * - **算子并集**（Q2）：baseline 的 `order_index` 在前，current 独有按自身 order_index
 *   追加尾部；缺侧 score=null → NOT_COMPARABLE。
 * - **分页少做**（Q3）：全量返回，`page = { nextCursor: null, total: cases.length }`。
 * - **null 指标透传**（Q4）：pass_rate/coverage 等 run 上为 null → metric 行两侧 null、
 *   delta/deltaPct 全 null，不伪造。
 * - **verdict 一律走契约 `verdictOf()`**（严格大于阈值），不重复实现退化判定。
 * - metric `label` 取 metric key 本身——展示文案归 Batch 3 前端层（flagged judgment）。
 */
import { CompareQuery, describeIncomparable, verdictOf } from '@eval-platform/contracts';
import type {
  CaseDiffRow,
  CompareCaseRow,
  CompareMetricRow,
  CompareResponse,
  DiffSummary,
  EvalRun,
  RunComparisonDiffResponse,
} from '@eval-platform/contracts';
import { getRun } from '../../../db/repo/evalRuns.js';
import {
  getConfirmedBaselineRunId,
  listEvaluatorOrderByRunIds,
  listResultsByRunIds,
  type CompareResultRow,
} from '../../../db/repo/compare.js';
import { BadRequestError, NotFoundError } from '../http.js';

const BANNER = '尚未确认基线，本次对比仅供观察，不作为门禁依据';

const METRIC_KEYS = [
  'score_overall',
  'pass_rate',
  'coverage',
  'latency_p50_ms',
  'latency_p95_ms',
  'cost_total',
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

/** 「变大是坏」的指标：latency 与 cost。其余（分/率/覆盖）变大是好。 */
function higherIsBetter(key: MetricKey): boolean {
  return !key.startsWith('latency_') && key !== 'cost_total';
}

function metricVal(run: EvalRun, key: MetricKey): number | null {
  const m = run.metrics;
  switch (key) {
    case 'score_overall':
      return m.scoreOverall;
    case 'pass_rate':
      return m.passRate;
    case 'coverage':
      return m.coverage;
    case 'latency_p50_ms':
      return m.latencyP50Ms;
    case 'latency_p95_ms':
      return m.latencyP95Ms;
    case 'cost_total':
      return m.costTotal;
  }
}

interface Side {
  run: EvalRun;
  /** case_key → 结果行（缺键 = 该侧没有这条结果）。 */
  results: Map<string, CompareResultRow>;
  ops: Array<{ key: string; kind: 'rule' | 'judge'; orderIndex: number }>;
}

function opScore(side: Side, caseKey: string, opKey: string): number | null {
  const row = side.results.get(caseKey);
  if (!row?.operatorScores) return null;
  const found = row.operatorScores.find((o) => o.key === opKey);
  return found && found.score !== null ? found.score : null;
}

async function loadContext(sp: URLSearchParams): Promise<{
  threshold: number;
  baseline: Side;
  current: Side;
  baselineConfirmed: boolean;
  banner: string | null;
}> {
  // 查询串的值一律是字符串；openapi 对该参数定义为 number 语义，在边界做一次数字化
  // （Number('abc') = NaN → BadRequestError 400，不静默放行也不让 Zod 收到字符串）
  const rawParams: Record<string, string | number> = Object.fromEntries(sp.entries());
  if (rawParams['regressionThreshold'] !== undefined) {
    const asNum = Number(rawParams['regressionThreshold']);
    if (Number.isNaN(asNum)) throw new BadRequestError('regressionThreshold 不是合法数字');
    rawParams['regressionThreshold'] = asNum;
  }
  const q = CompareQuery.parse(rawParams);
  const baselineRun = await getRun(q.baselineRunId);
  if (!baselineRun) throw new NotFoundError('基线运行不存在');
  const currentRun = await getRun(q.currentRunId);
  if (!currentRun) throw new NotFoundError('当前运行不存在');

  // 硬拒绝：维度穷举在契约函数里（版本不同 / 同 run 自比），非空即 400，不用 409
  const reason = describeIncomparable(baselineRun, currentRun);
  if (reason !== null) throw new BadRequestError(reason);

  const confirmedRunId = await getConfirmedBaselineRunId(baselineRun.datasetVersionId);
  const baselineConfirmed = confirmedRunId === q.baselineRunId;

  const [rows, orders] = await Promise.all([
    listResultsByRunIds([q.baselineRunId, q.currentRunId]),
    listEvaluatorOrderByRunIds([q.baselineRunId, q.currentRunId]),
  ]);

  const toSide = (run: EvalRun, runId: string): Side => ({
    run,
    results: new Map(rows.filter((r) => r.evalRunId === runId).map((r) => [r.caseKey, r])),
    ops: orders
      .filter((o) => o.evalRunId === runId)
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((o) => ({ key: o.evaluatorKey, kind: o.kind, orderIndex: o.orderIndex })),
  });

  return {
    threshold: q.regressionThreshold,
    baseline: toSide(baselineRun, q.baselineRunId),
    current: toSide(currentRun, q.currentRunId),
    baselineConfirmed,
    banner: baselineConfirmed ? null : BANNER,
  };
}

function metricRows(baseline: Side, current: Side): CompareMetricRow[] {
  return METRIC_KEYS.map((key) => {
    const bv = metricVal(baseline.run, key);
    const cv = metricVal(current.run, key);
    const delta = bv !== null && cv !== null ? cv - bv : null;
    // Q1：baseline 为 null 或 0 → deltaPct = null（不出 Infinity/NaN）
    const deltaPct = delta === null || bv === null || bv === 0 ? null : delta / bv;
    return { metric: key, label: key, baseline: bv, current: cv, delta, deltaPct, higherIsBetter: higherIsBetter(key) };
  });
}

function caseKeysOf(baseline: Side, current: Side): string[] {
  return [...new Set([...baseline.results.keys(), ...current.results.keys()])].sort();
}

function caseBaseRows(
  baseline: Side,
  current: Side,
  keys: string[],
  threshold: number,
): CompareCaseRow[] {
  return keys.map((k) => {
    const b = baseline.results.get(k);
    const c = current.results.get(k);
    const bScore = b?.score ?? null;
    const cScore = c?.score ?? null;
    const comparable = b !== undefined && c !== undefined && bScore !== null && cScore !== null;
    const delta = comparable ? (cScore as number) - (bScore as number) : null;
    const regressed = comparable && verdictOf(bScore, cScore, threshold) === 'REGRESSED';
    const alignmentWarning =
      b === undefined
        ? `case_key ${k} 仅在当前侧有结果，基线侧缺失`
        : c === undefined
          ? `case_key ${k} 仅在基线侧有结果，当前侧缺失`
          : null;
    return {
      caseKey: k,
      baselineScore: bScore,
      currentScore: cScore,
      delta,
      regressed,
      comparable,
      alignmentWarning,
    };
  });
}

function diffRows(
  baseline: Side,
  current: Side,
  keys: string[],
  threshold: number,
): { cases: CaseDiffRow[]; operators: RunComparisonDiffResponse['operators']; summary: DiffSummary } {
  // Q2：算子并集——baseline 序在前，current 独有按自身 order_index 追加
  const baseOps = baseline.ops.map((o) => o.key);
  const curOnly = current.ops.filter((o) => !baseOps.includes(o.key)).map((o) => o.key);
  const opKeys: string[] = [...baseOps, ...curOnly];
  const opKind = (key: string): 'rule' | 'judge' =>
    baseline.ops.find((o) => o.key === key)?.kind ?? current.ops.find((o) => o.key === key)!.kind;

  const cases: CaseDiffRow[] = [];
  const regByOp = new Map<string, number>();
  const impByOp = new Map<string, number>();
  for (const key of opKeys) {
    regByOp.set(key, 0);
    impByOp.set(key, 0);
  }

  let comparableCases = 0;
  let regressedCases = 0;
  let improvedCases = 0;
  let unchangedCases = 0;
  let notComparableCases = 0;

  for (const k of keys) {
    const b = baseline.results.get(k);
    const c = current.results.get(k);
    const bScore = b?.score ?? null;
    const cScore = c?.score ?? null;
    const comparable = b !== undefined && c !== undefined && bScore !== null && cScore !== null;
    const verdict = verdictOf(bScore, cScore, threshold);
    if (comparable) {
      comparableCases += 1;
      if (verdict === 'REGRESSED') regressedCases += 1;
      if (verdict === 'IMPROVED') improvedCases += 1;
      if (verdict === 'UNCHANGED') unchangedCases += 1;
    } else {
      notComparableCases += 1;
    }

    const operators = opKeys.map((opKey) => {
      const bOp = opScore(baseline, k, opKey);
      const cOp = opScore(current, k, opKey);
      const opVerdict = verdictOf(bOp, cOp, threshold);
      if (opVerdict === 'REGRESSED') regByOp.set(opKey, (regByOp.get(opKey) ?? 0) + 1);
      if (opVerdict === 'IMPROVED') impByOp.set(opKey, (impByOp.get(opKey) ?? 0) + 1);
      return {
        evaluatorKey: opKey,
        kind: opKind(opKey),
        baselineScore: bOp,
        currentScore: cOp,
        delta: bOp !== null && cOp !== null ? cOp - bOp : null,
        verdict: opVerdict,
      };
    });

    const alignmentWarning =
      b === undefined
        ? `case_key ${k} 仅在当前侧有结果，基线侧缺失`
        : c === undefined
          ? `case_key ${k} 仅在基线侧有结果，当前侧缺失`
          : null;

    cases.push({
      caseKey: k,
      comparable,
      alignmentWarning,
      // 侧缺行时显式 null（键必须存在：nullable ≠ 可省略）
      baselineStatus: (b?.status ?? null) as CaseDiffRow['baselineStatus'],
      currentStatus: (c?.status ?? null) as CaseDiffRow['currentStatus'],
      baselineScore: bScore,
      currentScore: cScore,
      delta: comparable ? (cScore as number) - (bScore as number) : null,
      regressed: verdict === 'REGRESSED',
      verdict,
      operators,
      baselineOutputText: b?.outputText ?? null,
      currentOutputText: c?.outputText ?? null,
      baselineResultId: b?.id ?? null,
      currentResultId: c?.id ?? null,
    });
  }

  const operators = opKeys.map((opKey) => {
    let bSum = 0;
    let bCount = 0;
    let cSum = 0;
    let cCount = 0;
    for (const k of keys) {
      const bOp = opScore(baseline, k, opKey);
      const cOp = opScore(current, k, opKey);
      if (bOp !== null) {
        bSum += bOp;
        bCount += 1;
      }
      if (cOp !== null) {
        cSum += cOp;
        cCount += 1;
      }
    }
    const baselineMean = bCount > 0 ? bSum / bCount : null;
    const currentMean = cCount > 0 ? cSum / cCount : null;
    const delta = baselineMean !== null && currentMean !== null ? currentMean - baselineMean : null;
    const deltaPct =
      delta === null || baselineMean === null || baselineMean === 0 ? null : delta / baselineMean;
    return {
      evaluatorKey: opKey,
      kind: opKind(opKey),
      baselineMean,
      currentMean,
      delta,
      deltaPct,
      baselineScoredCount: bCount,
      currentScoredCount: cCount,
      regressedCount: regByOp.get(opKey) ?? 0,
      improvedCount: impByOp.get(opKey) ?? 0,
      verdict: verdictOf(baselineMean, currentMean, threshold),
    };
  });

  const summary: DiffSummary = {
    totalCases: keys.length,
    comparableCases,
    regressedCases,
    improvedCases,
    unchangedCases,
    notComparableCases,
  };
  return { cases, operators, summary };
}

/** `GET /api/compare`（`PG-08` 汇总对比）。 */
export async function compareRuns(sp: URLSearchParams): Promise<CompareResponse> {
  const ctx = await loadContext(sp);
  const keys = caseKeysOf(ctx.baseline, ctx.current);
  return {
    baselineRun: ctx.baseline.run,
    currentRun: ctx.current.run,
    metrics: metricRows(ctx.baseline, ctx.current),
    cases: caseBaseRows(ctx.baseline, ctx.current, keys, ctx.threshold),
    page: { nextCursor: null, total: keys.length },
    baselineConfirmed: ctx.baselineConfirmed,
    banner: ctx.banner,
  };
}

/** `GET /api/compare/diff`（AB Diff 聚合）。 */
export async function compareRunsDiff(sp: URLSearchParams): Promise<RunComparisonDiffResponse> {
  const ctx = await loadContext(sp);
  const keys = caseKeysOf(ctx.baseline, ctx.current);
  const { cases, operators, summary } = diffRows(ctx.baseline, ctx.current, keys, ctx.threshold);
  return {
    datasetVersionId: ctx.baseline.run.datasetVersionId,
    baselineRun: ctx.baseline.run,
    currentRun: ctx.current.run,
    metrics: metricRows(ctx.baseline, ctx.current),
    cases,
    page: { nextCursor: null, total: keys.length },
    baselineConfirmed: ctx.baselineConfirmed,
    banner: ctx.banner,
    operators,
    summary,
    regressionThreshold: ctx.threshold,
  };
}
