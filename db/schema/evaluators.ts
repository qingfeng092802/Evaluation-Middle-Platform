/**
 * Drizzle 镜像 · 算子模板（`evaluators`）。
 *
 * M1 这张表**始终为空**：P0 跑批只用六个内置 key，`run_evaluators` 存快照。
 * 建表但不用，是为了让 M4 的 `PG-07` 能直接落地而不动 M1 结构。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const evaluators = pgTable(
  'evaluators',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    version: integer('version').notNull().default(1),
    configSchema: jsonb('config_schema').notNull(),
    defaultConfig: jsonb('default_config').notNull(),
    /** judge 专用。 */
    promptTemplate: text('prompt_template'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxKey: uniqueIndex('ux_evaluators_key').on(t.key),
    ckKind: check('ck_evaluators_kind', sql`${t.kind} IN ('rule', 'judge')`),
    ckVersionPos: check('ck_evaluators_version_pos', sql`${t.version} >= 1`),
    ckJudgePrompt: check(
      'ck_evaluators_judge_prompt',
      sql`${t.kind} <> 'judge' OR ${t.promptTemplate} IS NOT NULL`,
    ),
  }),
);
