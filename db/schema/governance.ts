/**
 * Drizzle 镜像 · 基线与门禁四表（`baselines` / `regression_gates` / `gate_evaluations` /
 * `case_human_labels`）。
 *
 * M1 这四张表**全部为空**：M3 才有基线确认，M4 才有门禁与人工标注界面。
 * 建表 + 镜像到位，是为了让后续里程碑不动 M1 的结构。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { datasets } from './datasets.js';
import { evalCaseResults, evalRuns } from './runs.js';
import { targets } from './targets.js';

export const baselines = pgTable(
  'baselines',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'restrict' }),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('NOMINATED'),
    note: text('note'),
    nominatedBy: text('nominated_by').notNull(),
    nominatedAt: timestamp('nominated_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    ckStatus: check(
      'ck_baselines_status',
      sql`${t.status} IN ('NOMINATED','CONFIRMED','REJECTED')`,
    ),
    ckDecision: check(
      'ck_baselines_decision',
      sql`${t.status} = 'NOMINATED' OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    ixDatasetStatus: index('ix_baselines_dataset_status').on(t.datasetId, t.status),
    /** ★ 每个评测集至多一个 CONFIRMED 基线（`BL-1` 的数据库级硬保证）。 */
    uxOneConfirmed: uniqueIndex('ux_baselines_one_confirmed')
      .on(t.datasetId)
      .where(sql`status = 'CONFIRMED'`),
  }),
);

export const regressionGates = pgTable(
  'regression_gates',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id').references(() => targets.id, { onDelete: 'restrict' }),
    baselineId: uuid('baseline_id').references(() => baselines.id, { onDelete: 'restrict' }),
    condition: jsonb('condition').notNull(),
    action: text('action').notNull().default('BLOCK'),
    isActive: boolean('is_active').notNull().default(true),
    /** 仅 webhook url，**绝无 PAT**（`工程规则.md` §9）。 */
    channels: jsonb('channels').notNull().default(sql`'[]'::jsonb`),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ckAction: check('ck_regression_gates_action', sql`${t.action} IN ('BLOCK','WARN')`),
    ckCond: check('ck_regression_gates_cond', sql`jsonb_typeof(${t.condition}) = 'object'`),
  }),
);

export const gateEvaluations = pgTable(
  'gate_evaluations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => regressionGates.id, { onDelete: 'cascade' }),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'restrict' }),
    passed: boolean('passed').notNull(),
    detail: jsonb('detail').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ixGateCreated: index('ix_gate_evaluations_gate_created').on(t.gateId, t.createdAt.desc()),
    ixRun: index('ix_gate_evaluations_run').on(t.evalRunId),
  }),
);

/**
 * 人工标注留痕（只增不改）。
 *
 * 独立成表而非在 `eval_case_results` 上加列：后者完全不可变，
 * 加列 = 给不可变红线开后门；删旧插新 = 篡改评测结果。
 */
export const caseHumanLabels = pgTable(
  'case_human_labels',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    evalCaseResultId: uuid('eval_case_result_id')
      .notNull()
      .references(() => evalCaseResults.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    severity: text('severity'),
    note: text('note'),
    labeledBy: text('labeled_by').notNull(),
    labeledAt: timestamp('labeled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ckLabelNotBlank: check(
      'ck_case_human_labels_label_not_blank',
      sql`length(btrim(${t.label})) > 0`,
    ),
    ckSeverity: check(
      'ck_case_human_labels_severity',
      sql`${t.severity} IS NULL OR ${t.severity} IN ('low', 'medium', 'high')`,
    ),
    ixResult: index('ix_case_human_labels_result').on(t.evalCaseResultId, t.labeledAt.desc()),
    ixLabel: index('ix_case_human_labels_label').on(t.label, t.labeledAt.desc()),
  }),
);
