/**
 * 仓储 · `eval_runs` 汇总视图 + 建 run 事务 + 终态聚合。
 *
 * 本文件承载三条最容易被写错的规则：
 *
 *  - **R-9 三个数的口径**：`score_overall`（质量）/ `pass_rate`（可用性）/ `coverage`（完整性）
 *    互不替代。`succeeded = 0` ⇒ `score_overall IS NULL`（禁止用 0 冒充）；
 *    该 run 无任何 `pass_threshold` ⇒ `pass_rate IS NULL`（不是 0）。
 *  - **R-10 P50/P95 在 DB 内算**（`percentile_cont`），不在 Node 里把全量耗时读出来排序。
 *  - **C-6 `cost_total` 只读生成列**：本文件从不写 `cost_total`，也不在 Node 里相加。
 *
 * 终态 UPDATE 一次性写全所有聚合字段：`eval_runs_guard()` 在状态落到终态的**那一刻**
 * 冻结整行，拆成两条 UPDATE 会让第二条被触发器拒绝。
 */
import type { EvalRun, EvalRunDetail } from '@eval-platform/contracts';
import { deriveTerminalStatus } from '@eval-platform/contracts';
import type { PoolClient } from 'pg';
import { iso, isoOrNull, num, numOrNull, query, queryOne, withTransaction } from './_client.js';

interface RunRow {
  id: string;
  name: string;
  status: string;
  dataset_version_id: string;
  target_version_id: string;
  concurrency: number;
  total_cases: number;
  succeeded_cases: number;
  failed_cases: number;
  skipped_cases: number;
  score_overall: string | null;
  pass_rate: string | null;
  coverage: string | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  tokens_in_total: string;
  tokens_out_total: string;
  cost_target: string;
  cost_judge: string;
  cost_total: string;
  config_snapshot: unknown;
  reproducibility: unknown;
  runner_version: string;
  trigger_source: string;
  baseline_run_id: string | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  cancel_requested_at: Date | null;
  dataset_label: string;
  target_label: string;
}

const RUN_SELECT = `
  SELECT r.*,
         COALESCE(d.name || ' @ v' || dv.version_no, dv.version_no::text) AS dataset_label,
         COALESCE(t.name || ' @ v' || tv.version_no, tv.version_no::text) AS target_label
    FROM eval_runs r
    JOIN dataset_versions dv ON dv.id = r.dataset_version_id
    JOIN datasets          d  ON d.id  = dv.dataset_id
    JOIN target_versions   tv ON tv.id = r.target_version_id
    JOIN targets           t  ON t.id  = tv.target_id
`;

function toRun(r: RunRow): EvalRun {
  return {
    id: r.id,
    name: r.name,
    status: r.status as EvalRun['status'],
    datasetVersionId: r.dataset_version_id,
    targetVersionId: r.target_version_id,
    datasetLabel: r.dataset_label,
    targetLabel: r.target_label,
    concurrency: r.concurrency,
    counts: {
      totalCases: r.total_cases,
      succeededCases: r.succeeded_cases,
      failedCases: r.failed_cases,
      skippedCases: r.skipped_cases,
    },
    metrics: {
      scoreOverall: numOrNull(r.score_overall),
      passRate: numOrNull(r.pass_rate),
      coverage: numOrNull(r.coverage),
      latencyP50Ms: r.latency_p50_ms,
      latencyP95Ms: r.latency_p95_ms,
      tokensInTotal: num(r.tokens_in_total),
      tokensOutTotal: num(r.tokens_out_total),
      costTarget: num(r.cost_target),
      costJudge: num(r.cost_judge),
      // C-6：只读数据库生成列，绝不在 Node 里 costTarget + costJudge
      costTotal: num(r.cost_total),
    },
    triggerSource: r.trigger_source as EvalRun['triggerSource'],
    baselineRunId: r.baseline_run_id,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    startedAt: isoOrNull(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
    cancelRequestedAt: isoOrNull(r.cancel_requested_at),
  };
}

export async function listRuns(opts: {
  limit: number;
  status?: string | undefined;
  datasetId?: string | undefined;
  targetId?: string | undefined;
}): Promise<EvalRun[]> {
  const rows = await query<RunRow>(
    `${RUN_SELECT}
      WHERE ($2::text IS NULL OR r.status = $2)
        AND ($3::uuid IS NULL OR dv.dataset_id = $3)
        AND ($4::uuid IS NULL OR tv.target_id  = $4)
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [opts.limit, opts.status ?? null, opts.datasetId ?? null, opts.targetId ?? null],
  );
  return rows.map(toRun);
}

export async function getRun(id: string): Promise<EvalRun | null> {
  const row = await queryOne<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [id]);
  return row ? toRun(row) : null;
}

interface RunEvaluatorRow {
  evaluator_key: string;
  evaluator_version: number;
  kind: string;
  config: unknown;
  weight: string;
  pass_threshold: string | null;
  order_index: number;
}

export async function listRunEvaluators(runId: string): Promise<RunEvaluatorRow[]> {
  return query<RunEvaluatorRow>(
    `SELECT evaluator_key, evaluator_version, kind, config, weight, pass_threshold, order_index
       FROM run_evaluators WHERE eval_run_id = $1 ORDER BY order_index ASC`,
    [runId],
  );
}

/** 详情 = 概要 + 快照 + 可复现性 + 算子清单。 */
export async function getRunDetail(id: string): Promise<EvalRunDetail | null> {
  const row = await queryOne<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [id]);
  if (!row) return null;
  const evals = await listRunEvaluators(id);
  return {
    ...toRun(row),
    configSnapshot: row.config_snapshot as EvalRunDetail['configSnapshot'],
    reproducibility: row.reproducibility as EvalRunDetail['reproducibility'],
    runnerVersion: row.runner_version,
    evaluators: evals.map((e) => ({
      evaluatorKey: e.evaluator_key,
      evaluatorVersion: e.evaluator_version,
      kind: e.kind as 'rule' | 'judge',
      weight: num(e.weight),
      passThreshold: numOrNull(e.pass_threshold),
      orderIndex: e.order_index,
    })),
  };
}

// ---------------------------------------------------------------------------
// 建 run（单一事务，[1] 的全部动作）
// ---------------------------------------------------------------------------

export interface CreateRunInput {
  readonly name: string;
  readonly datasetVersionId: string;
  readonly targetVersionId: string;
  readonly concurrency: number;
  readonly totalCases: number;
  readonly configSnapshot: unknown;
  readonly reproducibility: unknown;
  readonly runnerVersion: string;
  readonly triggerSource: string;
  readonly baselineRunId?: string | undefined;
  readonly createdBy: string;
  readonly evaluators: ReadonlyArray<{
    evaluatorKey: string;
    evaluatorVersion: number;
    kind: 'rule' | 'judge';
    config: unknown;
    weight: number;
    passThreshold: number | null;
  }>;
}

/**
 * 写入 `eval_runs` + `run_evaluators`（快照）。
 *
 * 只在**已通过三条阻塞校验**后调用；校验本身在 `lib/preflight`（可单测，不需要库）。
 */
export async function createRun(input: CreateRunInput): Promise<string> {
  return withTransaction(async (client: PoolClient) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO eval_runs
         (name, dataset_version_id, target_version_id, status, concurrency,
          total_cases, config_snapshot, reproducibility, runner_version,
          trigger_source, baseline_run_id, created_by)
       VALUES ($1, $2, $3, 'PENDING', $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.name,
        input.datasetVersionId,
        input.targetVersionId,
        input.concurrency,
        input.totalCases,
        JSON.stringify(input.configSnapshot),
        JSON.stringify(input.reproducibility),
        input.runnerVersion,
        input.triggerSource,
        input.baselineRunId ?? null,
        input.createdBy,
      ],
    );
    const runId = res.rows[0]?.id;
    if (!runId) throw new Error('createRun 未返回 id');

    let idx = 0;
    for (const e of input.evaluators) {
      await client.query(
        `INSERT INTO run_evaluators
           (eval_run_id, evaluator_key, evaluator_version, kind, config, weight, pass_threshold, order_index)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          runId,
          e.evaluatorKey,
          e.evaluatorVersion,
          e.kind,
          JSON.stringify(e.config),
          String(e.weight),
          e.passThreshold === null ? null : String(e.passThreshold),
          idx,
        ],
      );
      idx += 1;
    }

    return runId;
  });
}

// ---------------------------------------------------------------------------
// 终态聚合（[4]）
// ---------------------------------------------------------------------------

interface AggregateRow {
  total: string;
  succeeded: string;
  failed: string;
  skipped: string;
  score_overall: string | null;
  covered: string | null;
  p50: number | null;
  p95: number | null;
  tokens_in: string;
  tokens_out: string;
  cost_target: string;
  cost_judge: string;
  has_threshold: boolean;
}

/**
 * 计算并落终态。
 *
 * 计数与指标全部由 `eval_case_results` **现查**，不信任应用侧累加器：
 * 进程被杀重启后累加器就没了，而表里的行还在。
 */
export async function finalizeRun(runId: string, cancelled: boolean): Promise<string> {
  return withTransaction(async (client: PoolClient) => {
    const agg = await client.query<AggregateRow>(
      `WITH r AS (SELECT id, total_cases FROM eval_runs WHERE id = $1),
            c AS (
              SELECT
                count(*) FILTER (WHERE status = 'OK')::text                    AS succeeded,
                count(*) FILTER (WHERE status <> 'OK')::text                  AS failed,
                count(*) FILTER (WHERE status = 'SKIPPED')::text               AS skipped,
                avg(score) FILTER (WHERE status = 'OK')::text                  AS score_overall,
                count(*) FILTER (WHERE passed IS TRUE)::text                   AS covered,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)        AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)       AS p95,
                COALESCE(sum(tokens_in), 0)::text                              AS tokens_in,
                COALESCE(sum(tokens_out), 0)::text                             AS tokens_out,
                COALESCE(sum(cost_target), 0)::text                            AS cost_target,
                COALESCE(sum(cost_judge), 0)::text                             AS cost_judge
              FROM eval_case_results WHERE eval_run_id = $1
            )
       SELECT r.total_cases::text AS total, c.*,
              EXISTS (SELECT 1 FROM run_evaluators
                       WHERE eval_run_id = $1 AND pass_threshold IS NOT NULL) AS has_threshold
         FROM r CROSS JOIN c`,
      [runId],
    );
    const a = agg.rows[0];
    if (!a) throw new Error(`finalizeRun: 找不到 run ${runId}`);

    const total = Number(a.total);
    const succeeded = Number(a.succeeded);
    const failed = Number(a.failed);
    const skipped = Number(a.skipped);

    const status = deriveTerminalStatus({ totalCases: total, succeededCases: succeeded, cancelled });

    // R-9：FAILED 时分数必须为空（与 ck_eval_runs_failed_null_score 一致）
    const scoreOverall = status === 'FAILED' ? null : a.score_overall;
    // R-9：整个 run 没有任何 pass_threshold ⇒ pass_rate 为 NULL，不是 0
    const passRate =
      !a.has_threshold || total === 0 ? null : String(Number(a.covered) / total);
    const coverage = total === 0 ? null : String(succeeded / total);

    await client.query(
      `UPDATE eval_runs
          SET status = $2,
              succeeded_cases = $3,
              failed_cases = $4,
              skipped_cases = $5,
              score_overall = $6,
              pass_rate = $7,
              coverage = $8,
              latency_p50_ms = $9,
              latency_p95_ms = $10,
              tokens_in_total = $11,
              tokens_out_total = $12,
              cost_target = $13,
              cost_judge = $14,
              finished_at = now()
        WHERE id = $1`,
      [
        runId,
        status,
        succeeded,
        failed,
        skipped,
        scoreOverall,
        passRate,
        coverage,
        a.p50 === null ? null : Math.round(a.p50),
        a.p95 === null ? null : Math.round(a.p95),
        a.tokens_in,
        a.tokens_out,
        a.cost_target,
        a.cost_judge,
      ],
    );
    return status;
  });
}

/** 中止标记（`US-014`）：只置 `cancel_requested_at`，不回写已完成的 Case。 */
export async function requestCancel(runId: string): Promise<boolean> {
  const res = await query(
    `UPDATE eval_runs SET cancel_requested_at = now()
      WHERE id = $1 AND status IN ('PENDING','RUNNING') RETURNING id`,
    [runId],
  );
  return res.length > 0;
}

export async function isCancelRequested(runId: string): Promise<boolean> {
  const row = await queryOne<{ cancel_requested_at: Date | null }>(
    `SELECT cancel_requested_at FROM eval_runs WHERE id = $1`,
    [runId],
  );
  return !!row?.cancel_requested_at;
}
