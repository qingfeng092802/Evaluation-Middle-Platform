/**
 * M3 · Batch 2 —— `GET /api/compare/diff`（AB Diff 聚合，`US-010` / `US-011` 数据面）。
 *
 * 依据：`contracts/src/eval-contracts.ts` 的 `RunComparisonDiffResponse` /
 * `OperatorDiffRow` / `CaseDiffRow` / `DiffSummary` / `verdictOf()`（严格大于阈值，
 * 缺侧 NOT_COMPARABLE 不落 0 分）；`describeIncomparable()` 非空 → **400**（openapi
 * 「否则返回 400」）。实现前提四项裁定（2026-11-15）：deltaPct 除零/空 → null；
 * 算子并集 baseline 序优先、current 独有追加尾部、缺侧 null；分页少做
 * （page={nextCursor:null,total}）；null 指标透传。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RunComparisonDiffResponse,
  describeIncomparable,
} from '@eval-platform/contracts';
import type { EvalRun } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb } from '../db/schema/index.js';
import { buildCompareWorld, type CompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

// Route Handler（RED：本模块尚不存在）
import * as diffRoute from '../app/api/compare/diff/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';

function req(path: string): NextRequest {
  return new NextRequest(`${BASE}${path}`);
}

/** 断言前的键提取：缺键直接炸，避免 `undefined` 混进断言让失败信息失真。 */
function must<T>(v: T | undefined, k: string): T {
  if (v === undefined) throw new Error(`断言键缺失：${k}`);
  return v;
}

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
});

/** 标准世界（见 compare-fixtures 注释）：c1 改善 / c2 持平 / c3 当前侧 FAILED。 */
async function happyWorld(): Promise<CompareWorld> {
  return buildCompareWorld({
    name: 'diff-happy',
    baseline: {
      name: 'baseline',
      evaluators: [
        { key: 'recall_at_k', kind: 'rule', orderIndex: 0 },
        { key: 'json_schema', kind: 'rule', orderIndex: 1 },
      ],
      cases: [
        { caseKey: 'c1', score: 0.5, outputText: 'base-c1', operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.5 }, { key: 'json_schema', kind: 'rule', score: 0.5 } ] },
        { caseKey: 'c2', score: 0.9, outputText: 'base-c2', operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.9 }, { key: 'json_schema', kind: 'rule', score: 0.9 } ] },
        { caseKey: 'c3', score: 0.25, outputText: 'base-c3', operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.25 }, { key: 'json_schema', kind: 'rule', score: 0.25 } ] },
      ],
      metrics: { scoreOverall: 0.55, coverage: 1 },
    },
    current: {
      name: 'current',
      evaluators: [
        { key: 'recall_at_k', kind: 'rule', orderIndex: 0 },
        { key: 'json_schema', kind: 'rule', orderIndex: 1 },
      ],
      cases: [
        { caseKey: 'c1', score: 0.75, outputText: 'cur-c1', operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.75 }, { key: 'json_schema', kind: 'rule', score: 0.75 } ] },
        { caseKey: 'c2', score: 0.9, outputText: 'cur-c2', operatorScores: [ { key: 'recall_at_k', kind: 'rule', score: 0.9 }, { key: 'json_schema', kind: 'rule', score: 0.9 } ] },
        { caseKey: 'c3', status: 'FAILED', outputText: null },
      ],
      metrics: { scoreOverall: 0.825, coverage: null },
    },
  });
}

// ---------------------------------------------------------------------------
// A · 硬拒绝
// ---------------------------------------------------------------------------

describe('GET /api/compare/diff · 硬拒绝（describeIncomparable → 400）', () => {
  it('A1 版本不同 → 400，报错含契约函数返回原文', async () => {
    const w1 = await buildCompareWorld({ name: 'd1-x', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });
    const w2 = await buildCompareWorld({ name: 'd1-y', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });

    const expected = describeIncomparable(
      { id: w1.baselineRunId, datasetVersionId: w1.datasetVersionId } as unknown as EvalRun,
      { id: w2.currentRunId, datasetVersionId: w2.datasetVersionId } as unknown as EvalRun,
    );
    const res = await diffRoute.GET(req(`/api/compare/diff?baselineRunId=${w1.baselineRunId}&currentRunId=${w2.currentRunId}`));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(expected);
  });

  it('A2 同 run 自比 → 400，报错含契约函数返回原文', async () => {
    const w = await buildCompareWorld({ name: 'd2', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });
    const expected = describeIncomparable(
      { id: w.baselineRunId, datasetVersionId: w.datasetVersionId } as unknown as EvalRun,
      { id: w.baselineRunId, datasetVersionId: w.datasetVersionId } as unknown as EvalRun,
    );
    const res = await diffRoute.GET(req(`/api/compare/diff?baselineRunId=${w.baselineRunId}&currentRunId=${w.baselineRunId}`));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(expected);
  });
});

// ---------------------------------------------------------------------------
// B · happy path：summary / operators / cases / 回显
// ---------------------------------------------------------------------------

describe('GET /api/compare/diff · happy path 与数据准确性', () => {
  it('B1 summary 六计数精确；operators 顺序按 order_index；regressionThreshold 回显；page 少做（Q3）', async () => {
    const w = await happyWorld();
    const res = await diffRoute.GET(req(`/api/compare/diff?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}`));
    expect(res.status).toBe(200);
    const body = RunComparisonDiffResponse.parse(await res.json());

    expect(body.datasetVersionId).toBe(w.datasetVersionId);
    expect(body.regressionThreshold).toBe(0);
    expect(body.summary).toEqual({
      totalCases: 3,
      comparableCases: 2,
      regressedCases: 0,
      improvedCases: 1,
      unchangedCases: 1,
      notComparableCases: 1,
    });
    expect(body.operators.map((o) => o.evaluatorKey)).toEqual(['recall_at_k', 'json_schema']);
    expect(body.page).toEqual({ nextCursor: null, total: 3 });
    expect(body.cases.map((c) => c.caseKey)).toEqual(['c1', 'c2', 'c3']);
  });

  it('B3/B6 逐条：c1 IMPROVED +0.25、c2 UNCHANGED、c3 NOT_COMPARABLE 不落 0 分；两侧原文与 resultId 回填', async () => {
    const w = await happyWorld();
    const res = await diffRoute.GET(req(`/api/compare/diff?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}`));
    const body = RunComparisonDiffResponse.parse(await res.json());
    const byKey = Object.fromEntries(body.cases.map((c) => [c.caseKey, c]));

    expect(byKey['c1']).toMatchObject({
      comparable: true, baselineScore: 0.5, currentScore: 0.75,
      regressed: false, verdict: 'IMPROVED', alignmentWarning: null,
      baselineOutputText: 'base-c1', currentOutputText: 'cur-c1',
    });
    expect(must(byKey['c1'], 'c1').delta).toBeCloseTo(0.25, 12);
    expect(must(byKey['c1'], 'c1').baselineResultId).not.toBeNull();
    expect(must(byKey['c1'], 'c1').currentResultId).not.toBeNull();

    expect(byKey['c2']).toMatchObject({
      comparable: true, baselineScore: 0.9, currentScore: 0.9,
      delta: 0, regressed: false, verdict: 'UNCHANGED',
    });

    // 当前侧 FAILED ⇒ score null ⇒ NOT_COMPARABLE，绝不落 0 分
    expect(byKey['c3']).toMatchObject({
      comparable: false, baselineScore: 0.25, currentScore: null,
      delta: null, regressed: false, verdict: 'NOT_COMPARABLE',
    });
    expect(must(byKey['c3'], 'c3').operators.every((o) => o.currentScore === null && o.verdict === 'NOT_COMPARABLE')).toBe(true);
  });

  it('B4 OperatorDiffRow：分母=有效计分数（失败行不进分母，OPEN-5）；regressed/improved 计数逐算子', async () => {
    const w = await happyWorld();
    const res = await diffRoute.GET(req(`/api/compare/diff?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}`));
    const body = RunComparisonDiffResponse.parse(await res.json());
    const recall = body.operators.find((o) => o.evaluatorKey === 'recall_at_k');
    expect(recall).toBeDefined();

    // baseline 3 行均计分 → mean 0.55；current 仅 c1/c2 计分 → mean 0.825
    expect(recall?.baselineScoredCount).toBe(3);
    expect(recall?.currentScoredCount).toBe(2);
    expect(recall?.baselineMean).toBeCloseTo(0.55, 12);
    expect(recall?.currentMean).toBeCloseTo(0.825, 12);
    expect(recall?.delta).toBeCloseTo(0.275, 12);
    expect(recall?.deltaPct).toBeCloseTo(0.5, 12);
    expect(recall?.regressedCount).toBe(0);
    expect(recall?.improvedCount).toBe(1);
    expect(recall?.verdict).toBe('IMPROVED');
  });

  it('B2 verdictOf 边界：delta == ±threshold → UNCHANGED（严格大于才判），超出才 REGRESSED/IMPROVED', async () => {
    const w = await buildCompareWorld({
      name: 'diff-boundary',
      baseline: {
        name: 'baseline',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [
          { caseKey: 'b1', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] },
          { caseKey: 'b2', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] },
          { caseKey: 'b3', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] },
        ],
        metrics: {},
      },
      current: {
        name: 'current',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [
          { caseKey: 'b1', score: 0.4, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.4 }] }, // -0.1 == -threshold
          { caseKey: 'b2', score: 0.38, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.38 }] }, // -0.12 < -threshold
          { caseKey: 'b3', score: 0.6, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.6 }] }, // +0.1 == +threshold
        ],
        metrics: {},
      },
    });
    const res = await diffRoute.GET(
      req(`/api/compare/diff?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}&regressionThreshold=0.1`),
    );
    const body = RunComparisonDiffResponse.parse(await res.json());
    const byKey = Object.fromEntries(body.cases.map((c) => [c.caseKey, c]));
    expect(must(byKey['b1'], 'b1').verdict).toBe('UNCHANGED');
    expect(must(byKey['b1'], 'b1').regressed).toBe(false);
    expect(must(byKey['b2'], 'b2').verdict).toBe('REGRESSED');
    expect(must(byKey['b2'], 'b2').regressed).toBe(true);
    expect(must(byKey['b3'], 'b3').verdict).toBe('UNCHANGED');
    expect(body.summary).toMatchObject({ regressedCases: 1, improvedCases: 0, unchangedCases: 2 });
    expect(body.regressionThreshold).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// C · 对齐告警
// ---------------------------------------------------------------------------

describe('GET /api/compare/diff · alignmentWarning（case_key 缺侧显式告警）', () => {
  it('C1 一侧缺结果行 → alignmentWarning 非空 + comparable=false + 计入 notComparableCases', async () => {
    const w = await buildCompareWorld({
      name: 'diff-misaligned',
      baseline: {
        name: 'baseline',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [
          { caseKey: 'c1', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] },
          { caseKey: 'c4', score: 0.6, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.6 }] },
        ],
        metrics: {},
      },
      current: {
        name: 'current',
        evaluators: [{ key: 'json_schema', kind: 'rule', orderIndex: 0 }],
        cases: [
          { caseKey: 'c1', score: 0.5, operatorScores: [{ key: 'json_schema', kind: 'rule', score: 0.5 }] },
        ],
        metrics: {},
      },
    });
    const res = await diffRoute.GET(req(`/api/compare/diff?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}`));
    const body = RunComparisonDiffResponse.parse(await res.json());
    expect(body.cases).toHaveLength(2);
    const c4 = body.cases.find((c) => c.caseKey === 'c4');
    expect(c4?.comparable).toBe(false);
    expect(c4?.alignmentWarning).not.toBeNull();
    expect(c4?.alignmentWarning).toContain('c4');
    expect(c4?.verdict).toBe('NOT_COMPARABLE');
    expect(body.summary.notComparableCases).toBe(1);
    expect(body.summary.totalCases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Q2 · 算子并集：baseline 序优先，current 独有追加尾部，缺侧 null
// ---------------------------------------------------------------------------

describe('GET /api/compare/diff · 算子集不同的并集与顺序（Q2）', () => {
  it('并集 = baseline 序在前 + current 独有追加；缺侧 score=null → NOT_COMPARABLE', async () => {
    const w = await buildCompareWorld({
      name: 'diff-union',
      baseline: {
        name: 'baseline',
        evaluators: [
          { key: 'recall_at_k', kind: 'rule', orderIndex: 0 },
          { key: 'json_schema', kind: 'rule', orderIndex: 1 },
        ],
        cases: [
          {
            caseKey: 'c1',
            score: 0.5,
            operatorScores: [
              { key: 'recall_at_k', kind: 'rule', score: 0.5 },
              { key: 'json_schema', kind: 'rule', score: 0.5 },
            ],
          },
        ],
        metrics: {},
      },
      current: {
        name: 'current',
        evaluators: [
          { key: 'recall_at_k', kind: 'rule', orderIndex: 0 },
          { key: 'judge_quality', kind: 'judge', orderIndex: 1 },
        ],
        cases: [
          {
            caseKey: 'c1',
            score: 0.75,
            operatorScores: [
              { key: 'recall_at_k', kind: 'rule', score: 0.75 },
              { key: 'judge_quality', kind: 'judge', score: 0.9 },
            ],
          },
        ],
        metrics: {},
      },
    });
    const res = await diffRoute.GET(req(`/api/compare/diff?baselineRunId=${w.baselineRunId}&currentRunId=${w.currentRunId}`));
    const body = RunComparisonDiffResponse.parse(await res.json());

    // 顺序：baseline 的 order_index 在前，current 独有的 judge_quality 追加尾部
    expect(body.operators.map((o) => o.evaluatorKey)).toEqual(['recall_at_k', 'json_schema', 'judge_quality']);
    expect(must(body.cases[0], 'cases[0]').operators.map((o) => o.evaluatorKey)).toEqual(['recall_at_k', 'json_schema', 'judge_quality']);

    const byOp = Object.fromEntries(body.operators.map((o) => [o.evaluatorKey, o]));
    // recall 两侧都有 → IMPROVED
    expect(byOp['recall_at_k']).toMatchObject({ verdict: 'IMPROVED', regressedCount: 0, improvedCount: 1 });
    // current 没配 json_schema → 基线有值、当前 null → NOT_COMPARABLE
    expect(byOp['json_schema']).toMatchObject({ baselineMean: 0.5, currentMean: null, verdict: 'NOT_COMPARABLE' });
    // baseline 没配 judge_quality → 基线 null、当前 0.9 → NOT_COMPARABLE（deltaPct 也 null）
    expect(byOp['judge_quality']).toMatchObject({ baselineMean: null, currentMean: 0.9, delta: null, deltaPct: null, verdict: 'NOT_COMPARABLE' });
  });
});
