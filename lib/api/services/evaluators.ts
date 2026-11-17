/**
 * 算子库服务（M4 Batch 4，`US-016`，PG-07）。
 *
 * 内置六算子**不入库**：M1 起跑批只用内置 key（`run_evaluators` 存快照），
 * 清单在 service 层合成——`id` 是固定字面量 UUID（仅清单展示位，不入库、
 * 不可 PATCH、不参与建 run 引用），`configSchema` 是表单动态渲染的字段声明。
 *
 * PT-1 的兑现不在本层：`run_evaluators.config` 是建 run 时的快照（不可变表），
 * 模板改版只前进模板自身的 `version`，历史 run 天然不受影响。
 */
import { EvaluatorTemplateCreate, EvaluatorTemplateUpdate } from '@eval-platform/contracts';
import type { EvaluatorTemplate } from '@eval-platform/contracts';
import type { z } from 'zod';
import { ConflictError, NotFoundError } from '../http.js';
import {
  getTemplateById,
  keyExists,
  listCustomTemplates,
  insertTemplate as repoInsert,
  updateTemplate as repoUpdate,
} from '../../../db/repo/evaluators.js';

/** MVP 单机标识（OUT-4，与 gates/baselines 同口径）。 */
const LOCAL_ACTOR = 'local';

/**
 * 内置六算子只读清单。
 *
 * `id` 用固定字面量 UUID：契约 `EvaluatorTemplate.id` 必须是 uuid，而合成清单
 * 没有 DB 行——这些 id 只是展示位，**不入库、不可 PATCH（404）、建 run 引用的是
 * key 而非 id**。
 */
const BUILTIN_EVALUATORS: readonly EvaluatorTemplate[] = [
  {
    id: '00000000-0000-4000-8000-00000000e001',
    key: 'recall_at_k',
    kind: 'rule',
    displayName: '召回率 recall@k',
    description: 'Top-K 检索结果覆盖了多少相关文档（依赖 retrieval 标注）。',
    isBuiltin: true,
    version: 1,
    configSchema: { type: 'object', properties: { k: { type: 'integer', minimum: 1 }, gradeThreshold: { type: 'integer', minimum: 0 } }, required: ['k'] },
    defaultConfig: { key: 'recall_at_k', k: 5, gradeThreshold: 1 },
    createdBy: null,
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-00000000e002',
    key: 'mrr',
    kind: 'rule',
    displayName: '倒数排名 MRR',
    description: '第一个相关文档的倒数排名（依赖 retrieval 标注）。',
    isBuiltin: true,
    version: 1,
    configSchema: { type: 'object', properties: { gradeThreshold: { type: 'integer', minimum: 0 } }, required: [] },
    defaultConfig: { key: 'mrr', gradeThreshold: 1 },
    createdBy: null,
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-00000000e003',
    key: 'ndcg_at_k',
    kind: 'rule',
    displayName: '排序质量 nDCG@k',
    description: '带相关性等级的折损累积增益（依赖 retrieval 标注）。',
    isBuiltin: true,
    version: 1,
    configSchema: { type: 'object', properties: { k: { type: 'integer', minimum: 1 }, gainFormula: { const: 'standard' } }, required: ['k'] },
    defaultConfig: { key: 'ndcg_at_k', k: 10, gainFormula: 'standard' },
    createdBy: null,
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-00000000e004',
    key: 'json_schema',
    kind: 'rule',
    displayName: 'JSON 结构校验',
    description: '输出 JSON 是否符合内联 Schema（只校验结构，语义交给裁判）。',
    isBuiltin: true,
    version: 1,
    configSchema: { type: 'object', properties: { schema: { type: 'object' }, extractFromText: { type: 'boolean' } }, required: ['schema'] },
    defaultConfig: { key: 'json_schema', schema: { type: 'object' }, extractFromText: true },
    createdBy: null,
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-00000000e005',
    key: 'regex',
    kind: 'rule',
    displayName: '正则命中',
    description: '输出是否命中给定正则（可反向用于禁用词检查）。',
    isBuiltin: true,
    version: 1,
    configSchema: { type: 'object', properties: { pattern: { type: 'string' }, caseSensitive: { type: 'boolean' }, shouldMatch: { type: 'boolean' } }, required: ['pattern'] },
    defaultConfig: { key: 'regex', pattern: '.*', caseSensitive: false, shouldMatch: true },
    createdBy: null,
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-00000000e006',
    key: 'numeric_fidelity',
    kind: 'rule',
    displayName: '数值保真',
    description: '输出中的数值与参考答案数值是否保真（相对容差判等）。',
    isBuiltin: true,
    version: 1,
    configSchema: { type: 'object', properties: { tolerance: { type: 'number', minimum: 0, maximum: 1 }, missingFails: { type: 'boolean' } }, required: [] },
    defaultConfig: { key: 'numeric_fidelity', tolerance: 0.01, missingFails: true },
    createdBy: null,
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  },
];

export async function listEvaluatorTemplates(): Promise<{
  items: EvaluatorTemplate[];
  page: { nextCursor: null; total: number };
}> {
  const custom = await listCustomTemplates();
  const items = [...BUILTIN_EVALUATORS, ...custom];
  return { items, page: { nextCursor: null, total: items.length } };
}

export async function createEvaluatorTemplate(raw: unknown): Promise<EvaluatorTemplate> {
  const input = EvaluatorTemplateCreate.parse(raw);
  // 契约只允许 judge 分支；但 key 冲突的 409 语义比唯一约束更精确，前置拦截
  if (BUILTIN_EVALUATORS.some((b) => b.key === input.key)) {
    throw new ConflictError('key 与内置算子冲突（内置算子不可覆盖）', { key: input.key });
  }
  if (await keyExists(input.key)) {
    throw new ConflictError('同名模板已存在', { key: input.key });
  }
  return repoInsert({
    key: input.key,
    displayName: input.displayName,
    description: input.description ?? null,
    config: input.config as z.infer<typeof EvaluatorTemplateCreate>['config'],
    createdBy: LOCAL_ACTOR,
  });
}

export async function updateEvaluatorTemplate(id: string, raw: unknown): Promise<EvaluatorTemplate> {
  const patchInput = EvaluatorTemplateUpdate.parse(raw);
  const existing = await getTemplateById(id);
  if (existing === null) throw new NotFoundError('算子模板不存在（内置算子为合成清单，不可改）');
  const patch: {
    displayName?: string | undefined;
    description?: string | undefined;
    config?: z.infer<typeof EvaluatorTemplateUpdate>['config'];
  } = {};
  if (patchInput.displayName !== undefined) patch.displayName = patchInput.displayName;
  if (patchInput.description !== undefined) patch.description = patchInput.description;
  if (patchInput.config !== undefined) {
    if (existing.isBuiltin) {
      throw new ConflictError('内置算子不可改 config 语义', { key: existing.key });
    }
    patch.config = patchInput.config as z.infer<typeof EvaluatorTemplateUpdate>['config'];
  }
  const updated = await repoUpdate(id, patch);
  if (!updated) throw new NotFoundError('算子模板不存在');
  return updated;
}
