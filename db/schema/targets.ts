/**
 * Drizzle 镜像 · 待测目标（`targets` / `target_versions`）。
 *
 * `ck_target_versions_t1` / `ck_target_versions_t2` 是「T1 / T2 字段不可互相污染」的
 * 数据库级保证：T1 行不允许缺 modelId / promptTemplate，T2 行不允许缺 endpoint_url。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { modelProviders } from './providers.js';

export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    /** 尚无版本时为 0。 */
    currentVersionNo: integer('current_version_no').notNull().default(0),
    workspaceId: text('workspace_id').notNull().default('default'),
    ownerId: text('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxWorkspaceName: uniqueIndex('ux_targets_workspace_name').on(t.workspaceId, t.name),
    ckKind: check('ck_targets_kind', sql`${t.kind} IN ('t1_prompt', 't2_http')`),
    ckCurVer: check('ck_targets_cur_ver', sql`${t.currentVersionNo} >= 0`),
  }),
);

export const targetVersions = pgTable(
  'target_versions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    kind: text('kind').notNull(),

    modelProviderId: uuid('model_provider_id').references(() => modelProviders.id, {
      onDelete: 'restrict',
    }),
    modelId: text('model_id'),
    promptTemplate: text('prompt_template'),
    temperature: numeric('temperature', { precision: 3, scale: 2 }),
    maxTokens: integer('max_tokens'),
    params: jsonb('params'),

    endpointUrl: text('endpoint_url'),
    /** 密文；任何响应都不返回。 */
    authHeaderCiphertext: text('auth_header_ciphertext'),
    requestMapping: jsonb('request_mapping'),
    responseMapping: jsonb('response_mapping'),

    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxNo: uniqueIndex('ux_target_versions_no').on(t.targetId, t.versionNo),
    ckNoPos: check('ck_target_versions_no_pos', sql`${t.versionNo} >= 1`),
    ckKind: check('ck_target_versions_kind', sql`${t.kind} IN ('t1_prompt', 't2_http')`),
    ckT1: check(
      'ck_target_versions_t1',
      sql`${t.kind} <> 't1_prompt' OR (${t.modelProviderId} IS NOT NULL AND ${t.modelId} IS NOT NULL AND ${t.promptTemplate} IS NOT NULL AND ${t.temperature} IS NOT NULL AND ${t.maxTokens} IS NOT NULL)`,
    ),
    ckT2: check(
      'ck_target_versions_t2',
      sql`${t.kind} <> 't2_http' OR (${t.endpointUrl} IS NOT NULL AND ${t.requestMapping} IS NOT NULL AND ${t.responseMapping} IS NOT NULL)`,
    ),
    ckTemp: check(
      'ck_target_versions_temp',
      sql`${t.temperature} IS NULL OR (${t.temperature} >= 0 AND ${t.temperature} <= 2)`,
    ),
    ckMaxTok: check('ck_target_versions_maxtok', sql`${t.maxTokens} IS NULL OR ${t.maxTokens} > 0`),
  }),
);
