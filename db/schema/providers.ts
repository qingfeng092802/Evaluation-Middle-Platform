/**
 * Drizzle 镜像 · 厂商与单价（`model_providers` / `model_prices`）。
 *
 * 安全红线：`apiKeyCiphertext` **只写不读**。查询层若需返回给前端，
 * 必须走 `ModelProvider` 契约（无该字段）而不是整行透传（`工程规则.md` §9）。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const modelProviders = pgTable(
  'model_providers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    baseUrl: text('base_url'),
    /** 密文；任何 API 都不返回。 */
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    /** 形如 `sk-••••3f2a`，仅供用户确认配的是哪把 Key。 */
    apiKeyMasked: text('api_key_masked').notNull(),
    maxConcurrency: integer('max_concurrency').notNull().default(4),
    rpmLimit: integer('rpm_limit'),
    tpmLimit: integer('tpm_limit'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxName: uniqueIndex('ux_model_providers_name').on(t.name),
    ckKind: check(
      'ck_model_providers_kind',
      sql`${t.kind} IN ('openai_compatible', 'anthropic', 'litellm')`,
    ),
    ckConc: check('ck_model_providers_conc', sql`${t.maxConcurrency} > 0`),
    ckRpm: check('ck_model_providers_rpm', sql`${t.rpmLimit} IS NULL OR ${t.rpmLimit} > 0`),
    ckTpm: check('ck_model_providers_tpm', sql`${t.tpmLimit} IS NULL OR ${t.tpmLimit} > 0`),
  }),
);

export const modelPrices = pgTable(
  'model_prices',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    modelProviderId: uuid('model_provider_id')
      .notNull()
      .references(() => modelProviders.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    inputPricePer1k: numeric('input_price_per_1k', { precision: 18, scale: 8 }).notNull(),
    outputPricePer1k: numeric('output_price_per_1k', { precision: 18, scale: 8 }).notNull(),
    currency: text('currency').notNull().default('CNY'),
    /** 调价只增行不改行（`MP-2`），靠本列区分生效时点。 */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uxProviderModelFrom: uniqueIndex('ux_model_prices_provider_model_from').on(
      t.modelProviderId,
      t.modelId,
      t.effectiveFrom,
    ),
    ckInput: check('ck_model_prices_input', sql`${t.inputPricePer1k} >= 0`),
    ckOutput: check('ck_model_prices_output', sql`${t.outputPricePer1k} >= 0`),
    ixLookup: index('ix_model_prices_lookup').on(
      t.modelProviderId,
      t.modelId,
      t.effectiveFrom.desc(),
    ),
  }),
);
