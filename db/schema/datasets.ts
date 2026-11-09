/**
 * Drizzle 镜像 · 评测集三表（`datasets` / `dataset_versions` / `dataset_cases`）。
 *
 * **本文件不是 DDL 的事实源。** 建表事实源是 `db/migrations/0001…0003.sql`
 * （`technical-solution.md` `TS-4` 短板 3：Drizzle 表达不了触发器，漂移不可避免）。
 * 这里只做两件事：
 *   1. 让查询层有类型；
 *   2. 让 `tests/db-schema.spec.ts` 能断言「镜像里的表/列名与迁移里的真实结构一致」，
 *      把漂移从「没人发现」变成「测试失败」。
 *
 * 约束与索引在此**照抄**但不承担强制力：真正生效的是 SQL 里那份。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    description: text('description'),
    /** 预留：首版固定 'default'，不启用权限。 */
    workspaceId: text('workspace_id').notNull().default('default'),
    ownerId: text('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxWorkspaceName: uniqueIndex('ux_datasets_workspace_name').on(t.workspaceId, t.name),
    ckNameNotBlank: check('ck_datasets_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    ixCreatedAt: index('ix_datasets_created_at').on(t.createdAt.desc()),
  }),
);

export const datasetVersions = pgTable(
  'dataset_versions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    schemaVersion: text('schema_version').notNull().default('1'),
    caseCount: integer('case_count').notNull().default(0),
    contentHash: text('content_hash').notNull(),
    source: text('source').notNull(),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxNo: uniqueIndex('ux_dataset_versions_no').on(t.datasetId, t.versionNo),
    ckNoPos: check('ck_dataset_versions_no_pos', sql`${t.versionNo} >= 1`),
    ckCount: check('ck_dataset_versions_count', sql`${t.caseCount} >= 0`),
    ckSource: check(
      'ck_dataset_versions_source',
      sql`${t.source} IN ('import', 'mine', 'backflow')`,
    ),
    ckSchema: check('ck_dataset_versions_schema', sql`${t.schemaVersion} = '1'`),
    ixDatasetCreated: index('ix_dataset_versions_dataset_created').on(
      t.datasetId,
      t.createdAt.desc(),
    ),
    ixDatasetHash: index('ix_dataset_versions_dataset_hash').on(t.datasetId, t.contentHash),
  }),
);

export const datasetCases = pgTable(
  'dataset_cases',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    datasetVersionId: uuid('dataset_version_id')
      .notNull()
      .references(() => datasetVersions.id, { onDelete: 'restrict' }),
    caseKey: text('case_key').notNull(),
    /** 版本内 0-based，按 `case_key` 升序（SPEC-M1 R-2）。 */
    seq: integer('seq').notNull(),
    input: jsonb('input').notNull(),
    reference: jsonb('reference'),
    retrieval: jsonb('retrieval'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxVersionKey: uniqueIndex('ux_dataset_cases_version_key').on(t.datasetVersionId, t.caseKey),
    uxVersionSeq: uniqueIndex('ux_dataset_cases_version_seq').on(t.datasetVersionId, t.seq),
    ckKeyNotBlank: check('ck_dataset_cases_key_not_blank', sql`length(btrim(${t.caseKey})) > 0`),
    ckSeqPos: check('ck_dataset_cases_seq_pos', sql`${t.seq} >= 0`),
    ckInputObj: check('ck_dataset_cases_input_obj', sql`jsonb_typeof(${t.input}) = 'object'`),
    ckMetaObj: check('ck_dataset_cases_meta_obj', sql`jsonb_typeof(${t.metadata}) = 'object'`),
    ixVersionSeq: index('ix_dataset_cases_version_seq').on(t.datasetVersionId, t.seq),
    /** 业务标签筛选（如「只看难度=hard」）。 */
    ixMetadataKey: index('ix_dataset_cases_metadata_key').on(
      t.datasetVersionId,
      sql`(metadata -> 'difficulty')`,
    ),
    /** 检索算子可行性判定（PG-02 步骤 3 阻塞校验的依据）。 */
    ixHasRetrieval: index('ix_dataset_cases_has_retrieval')
      .on(t.datasetVersionId)
      .where(sql`retrieval IS NOT NULL`),
  }),
);
