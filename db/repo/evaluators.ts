/**
 * evaluators（裁判模板侧）仓储（M4 Batch 4，`US-016`，PG-07）。
 *
 * 内置六算子**不入库**（M1 起口径：P0 跑批只用内置 key，清单由 service 层合成）；
 * 本表只存自定义裁判模板。`key` 全局唯一（ux_evaluators_key，含内置 key 的占用
 * 由 service 层前置拦截，给出比唯一约束更精确的 409 语义）。
 *
 * 版本语义（PT-1）：`config` 变更 ⇒ `version + 1` 并同步 `default_config` /
 * `prompt_template`；`display_name` / `description` 变更不动版本——它们只是展示位，
 * 历史快照引用的是 config 的形状。
 */
import type { z } from 'zod';
import type { EvaluatorTemplateCreate, EvaluatorTemplateUpdate } from '@eval-platform/contracts';
import type { EvaluatorTemplate } from '@eval-platform/contracts';
import { iso, query, queryOne } from './_client.js';

interface EvaluatorRow {
  id: string;
  key: string;
  kind: string;
  display_name: string;
  description: string | null;
  is_builtin: boolean;
  version: number;
  config_schema: unknown;
  default_config: unknown;
  prompt_template: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS =
  'id, key, kind, display_name, description, is_builtin, version, config_schema, default_config, prompt_template, created_by, created_at, updated_at';

function mapTemplate(r: EvaluatorRow): EvaluatorTemplate {
  return {
    id: r.id,
    key: r.key,
    kind: r.kind as EvaluatorTemplate['kind'],
    displayName: r.display_name,
    description: r.description,
    isBuiltin: r.is_builtin,
    version: r.version,
    configSchema: (r.config_schema ?? {}) as Record<string, unknown>,
    defaultConfig: (r.default_config ?? {}) as EvaluatorTemplate['defaultConfig'],
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getTemplateById(id: string): Promise<EvaluatorTemplate | null> {
  const row = await queryOne<EvaluatorRow>(`SELECT ${COLUMNS} FROM evaluators WHERE id = $1`, [id]);
  return row ? mapTemplate(row) : null;
}

export async function listCustomTemplates(): Promise<EvaluatorTemplate[]> {
  const rows = await query<EvaluatorRow>(`SELECT ${COLUMNS} FROM evaluators WHERE is_builtin = false ORDER BY created_at`, []);
  return rows.map(mapTemplate);
}

export async function keyExists(key: string): Promise<boolean> {
  const row = await queryOne<{ ok: number }>('SELECT 1 AS ok FROM evaluators WHERE key = $1', [key]);
  return row !== null;
}

/** 裁判模板参数的可编辑字段声明（供 PG-07 表单动态渲染的轻量 JSON Schema）。 */
const JUDGE_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    modelProviderId: { type: 'string', format: 'uuid' },
    modelId: { type: 'string' },
    promptTemplate: { type: 'string' },
    scaleMax: { type: 'integer', enum: [1, 5, 10] },
    passThreshold: { type: 'number', minimum: 0, maximum: 1 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxTokens: { type: 'integer', minimum: 1 },
  },
  required: ['modelProviderId', 'modelId', 'promptTemplate'],
} as const;

export async function insertTemplate(input: {
  key: string;
  displayName: string;
  description: string | null;
  config: z.infer<typeof EvaluatorTemplateCreate>['config'];
  createdBy: string;
}): Promise<EvaluatorTemplate> {
  const row = await queryOne<EvaluatorRow>(
    `INSERT INTO evaluators (key, kind, display_name, description, is_builtin, version, config_schema, default_config, prompt_template, created_by)
     VALUES ($1, 'judge', $2, $3, false, 1, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.key,
      input.displayName,
      input.description,
      JSON.stringify(JUDGE_CONFIG_SCHEMA),
      JSON.stringify(input.config),
      input.config.promptTemplate,
      input.createdBy,
    ],
  );
  if (!row) throw new Error('INSERT … RETURNING 未返回行');
  return mapTemplate(row);
}

export interface EvaluatorPatch {
  displayName?: string | undefined;
  description?: string | undefined;
  config?: z.infer<typeof EvaluatorTemplateUpdate>['config'];
}

export async function updateTemplate(id: string, patch: EvaluatorPatch): Promise<EvaluatorTemplate | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  const configChanged = patch.config !== undefined;
  if (configChanged) sets.push('version = version + 1');
  if (patch.displayName !== undefined) {
    params.push(patch.displayName);
    sets.push(`display_name = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }
  if (configChanged) {
    params.push(JSON.stringify(patch.config));
    sets.push(`default_config = $${params.length}::jsonb`);
    params.push(patch.config!.promptTemplate);
    sets.push(`prompt_template = $${params.length}`);
  }
  params.push(id);
  const row = await queryOne<EvaluatorRow>(
    `UPDATE evaluators SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  return row ? mapTemplate(row) : null;
}
