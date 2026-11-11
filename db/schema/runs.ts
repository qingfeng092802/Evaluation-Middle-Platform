/**
 * Drizzle 镜像 · 运行四表（`eval_runs` / `run_evaluators` / `eval_case_results`）。
 *
 * 两个**只能在 SQL 里表达**的点，镜像刻意照抄而不假装能强制：
 *  1. `cost_total` 是 `GENERATED ALWAYS AS (cost_target + cost_judge) STORED` ——
 *     这里用 `generatedAlwaysAs` 声明，**应用侧永不写它**（C-6 / `ER-3`）；
 *  2. `eval_runs` 的终态冻结与单向流转由 `eval_runs_guard()` 触发器执行，
 *     Drizzle 无法表达，`T-10` 是唯一护栏。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { datasetCases, datasetVersions } from './datasets.js';
import { targetVersions } from './targets.js';

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    datasetVersionId: uuid('dataset_version_id')
      .notNull()
      .references(() => datasetVersions.id, { onDelete: 'restrict' }),
    targetVersionId: uuid('target_version_id')
      .notNull()
      .references(() => targetVersions.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('PENDING'),
    concurrency: integer('concurrency').notNull(),

    totalCases: integer('total_cases').notNull().default(0),
    succeededCases: integer('succeeded_cases').notNull().default(0),
    failedCases: integer('failed_cases').notNull().default(0),
    skippedCases: integer('skipped_cases').notNull().default(0),

    /** 质量；NULL = 无可评样本，禁止用 0 冒充（`OPEN-5`）。 */
    scoreOverall: numeric('score_overall', { precision: 10, scale: 6 }),
    /** 可用性；本 run 无任何 pass_threshold ⇒ NULL。 */
    passRate: numeric('pass_rate', { precision: 10, scale: 6 }),
    /** 完整性 = succeeded / total。 */
    coverage: numeric('coverage', { precision: 10, scale: 6 }),

    latencyP50Ms: integer('latency_p50_ms'),
    latencyP95Ms: integer('latency_p95_ms'),

    tokensInTotal: bigint('tokens_in_total', { mode: 'number' }).notNull().default(0),
    tokensOutTotal: bigint('tokens_out_total', { mode: 'number' }).notNull().default(0),

    costTarget: numeric('cost_target', { precision: 18, scale: 8 }).notNull().default('0'),
    costJudge: numeric('cost_judge', { precision: 18, scale: 8 }).notNull().default('0'),
    costTotal: numeric('cost_total', { precision: 18, scale: 8 }).generatedAlwaysAs(
      sql`cost_target + cost_judge`,
    ),

    configSnapshot: jsonb('config_snapshot').notNull(),
    reproducibility: jsonb('reproducibility').notNull(),
    runnerVersion: text('runner_version').notNull(),

    triggerSource: text('trigger_source').notNull().default('MANUAL'),
    baselineRunId: uuid('baseline_run_id'),

    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    /**
     * 租约心跳（#6 方案 A）。worker 处理期间按 `TTL / 3` 续写；
     * NULL 表示尚未心跳，回收判定回退到 `started_at`。
     */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  },
  (t) => ({
    ckStatus: check(
      'ck_eval_runs_status',
      sql`${t.status} IN ('PENDING','RUNNING','COMPLETED','PARTIAL_FAILED','FAILED','CANCELLED')`,
    ),
    ckConc: check('ck_eval_runs_conc', sql`${t.concurrency} > 0`),
    ckSource: check('ck_eval_runs_source', sql`${t.triggerSource} IN ('MANUAL','CI_WEBHOOK')`),
    ckNoSelfBaseline: check(
      'ck_eval_runs_no_self_baseline',
      sql`${t.baselineRunId} IS DISTINCT FROM ${t.id}`,
    ),
    ckCounts: check(
      'ck_eval_runs_counts',
      sql`${t.totalCases} >= 0 AND ${t.succeededCases} >= 0 AND ${t.failedCases} >= 0 AND ${t.skippedCases} >= 0 AND ${t.succeededCases} + ${t.failedCases} + ${t.skippedCases} <= ${t.totalCases}`,
    ),
    ckScore: check(
      'ck_eval_runs_score',
      sql`${t.scoreOverall} IS NULL OR (${t.scoreOverall} >= 0 AND ${t.scoreOverall} <= 1)`,
    ),
    ckPass: check(
      'ck_eval_runs_pass',
      sql`${t.passRate} IS NULL OR (${t.passRate} >= 0 AND ${t.passRate} <= 1)`,
    ),
    ckCov: check(
      'ck_eval_runs_cov',
      sql`${t.coverage} IS NULL OR (${t.coverage} >= 0 AND ${t.coverage} <= 1)`,
    ),
    ckFailedNullScore: check(
      'ck_eval_runs_failed_null_score',
      sql`${t.status} <> 'FAILED' OR ${t.scoreOverall} IS NULL`,
    ),
    ixStatusCreated: index('ix_eval_runs_status_created').on(t.status, t.createdAt.desc()),
    ixCreated: index('ix_eval_runs_created').on(t.createdAt.desc()),
    ixDsVersion: index('ix_eval_runs_ds_version').on(t.datasetVersionId),
    ixTargetVersion: index('ix_eval_runs_target_version').on(t.targetVersionId),
    /** 队列领取专用（部分索引）。 */
    ixPending: index('ix_eval_runs_pending')
      .on(t.createdAt)
      .where(sql`status = 'PENDING'`),
    /** 僵尸回收：找「RUNNING 且启动已久」。 */
    ixRunningStarted: index('ix_eval_runs_running_started')
      .on(t.startedAt)
      .where(sql`status = 'RUNNING'`),
    ixBaselineRun: index('ix_eval_runs_baseline_run')
      .on(t.baselineRunId)
      .where(sql`baseline_run_id IS NOT NULL`),
  }),
);

export const runEvaluators = pgTable(
  'run_evaluators',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    evaluatorKey: text('evaluator_key').notNull(),
    evaluatorVersion: integer('evaluator_version').notNull(),
    kind: text('kind').notNull(),
    /** 建 run 时的完整参数快照，不引用模板（`PT-1`）。 */
    config: jsonb('config').notNull(),
    weight: numeric('weight', { precision: 6, scale: 4 }).notNull().default('1'),
    passThreshold: numeric('pass_threshold', { precision: 10, scale: 6 }),
    orderIndex: integer('order_index').notNull(),
  },
  (t) => ({
    uxKey: uniqueIndex('ux_run_evaluators_key').on(t.evalRunId, t.evaluatorKey),
    ckKind: check('ck_run_evaluators_kind', sql`${t.kind} IN ('rule', 'judge')`),
    ckW: check('ck_run_evaluators_w', sql`${t.weight} >= 0`),
    ckOrder: check('ck_run_evaluators_order', sql`${t.orderIndex} >= 0`),
    ixRunOrder: index('ix_run_evaluators_run_order').on(t.evalRunId, t.orderIndex),
  }),
);

export const evalCaseResults = pgTable(
  'eval_case_results',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    datasetCaseId: uuid('dataset_case_id')
      .notNull()
      .references(() => datasetCases.id, { onDelete: 'restrict' }),
    caseKey: text('case_key').notNull(),

    outputText: text('output_text'),
    outputRaw: jsonb('output_raw'),
    retrievalReturned: jsonb('retrieval_returned'),

    status: text('status').notNull(),
    errorMessage: text('error_message'),
    score: numeric('score', { precision: 10, scale: 6 }),
    passed: boolean('passed'),
    operatorScores: jsonb('operator_scores'),
    judgeReasoning: text('judge_reasoning'),

    latencyMs: integer('latency_ms'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costTarget: numeric('cost_target', { precision: 18, scale: 8 }).notNull().default('0'),
    costJudge: numeric('cost_judge', { precision: 18, scale: 8 }).notNull().default('0'),
    costTotal: numeric('cost_total', { precision: 18, scale: 8 }).generatedAlwaysAs(
      sql`cost_target + cost_judge`,
    ),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxRunKey: uniqueIndex('ux_eval_case_results_run_key').on(t.evalRunId, t.caseKey),
    ckStatus: check(
      'ck_eval_case_results_status',
      sql`${t.status} IN ('OK','FAILED','TIMEOUT','PARSE_ERROR','QUOTA_EXCEEDED','SKIPPED')`,
    ),
    ckScore: check(
      'ck_eval_case_results_score',
      sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 1)`,
    ),
    /**
     * 只有单向：`status='OK' ⇒ score IS NOT NULL`。
     * 反向规则（非 OK ⇒ score 必须 NULL）由应用侧 `EvalCaseResult` 的第二条 refine 承担
     * （SPEC-M1 C-3），因为 CHECK 无法表达「任何未来的非 OK 状态」。
     */
    ckOkScore: check(
      'ck_eval_case_results_ok_score',
      sql`${t.status} <> 'OK' OR ${t.score} IS NOT NULL`,
    ),
    ckTok: check('ck_eval_case_results_tok', sql`${t.tokensIn} >= 0 AND ${t.tokensOut} >= 0`),
    ixRunScore: index('ix_eval_case_results_run_score').on(t.evalRunId, t.score),
    ixRunStatus: index('ix_eval_case_results_run_status').on(t.evalRunId, t.status),
    ixRunLatency: index('ix_eval_case_results_run_latency').on(t.evalRunId, t.latencyMs),
  }),
);
