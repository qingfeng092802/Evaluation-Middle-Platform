/**
 * Dataset / DatasetVersion / DatasetCase 契约（`ED-01`…`ED-03`）。
 *
 * 事实源：
 *  - `docs/facts/database-schema.md` §2.1–2.3
 *  - `docs/facts/product-overview.md` §7「Dataset Version 最小完备契约」
 *  - `docs/facts/pages-and-flows.md` PG-05
 *
 * 不可变红线（`PT-2`）：DatasetVersion 与 DatasetCase 一经创建**永不修改**。
 * 因此本文件对二者**不导出任何 Update 入参**——「没有 Update 契约」
 * 比「在文档里写一句不可变」是更硬的约束。
 *
 * 命名约定：传输层（API）一律 camelCase；`input` / `reference` / `retrieval`
 * 三个 jsonb 字段的内部 key 沿用 `product-overview.md` §7 的 snake_case 原文，
 * 因为它们是被搬运的**数据内容**，不是列名。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';

// ---------------------------------------------------------------------------
// ED-03 · Case
// ---------------------------------------------------------------------------

/** 检索标注单条：`doc_id` + 相关性等级（`grade >= 1` 才计入「相关」）。 */
export const RetrievalRelevantItem = z.object({
  doc_id: z.string().min(1),
  /**
   * nDCG@K 的增益来源。`0` =「召回了但无关」，与「未召回」语义不同，
   * 故允许 0，不允许负数。
   */
  grade: z.number().int().min(0),
});
export type RetrievalRelevantItem = z.infer<typeof RetrievalRelevantItem>;

/**
 * 检索标注。缺此字段 ⇒ Recall@K / MRR / nDCG@K 三个 P0 算子全部不可用
 * （product-overview §7.3-1）。
 */
export const RetrievalAnnotation = z.object({
  relevant: z.array(RetrievalRelevantItem).min(1),
});
export type RetrievalAnnotation = z.infer<typeof RetrievalAnnotation>;

/**
 * Case 输入。`query` 必填，其余变量（`history` / `context` / 任意业务字段）
 * 以未知 key 同行存放。
 *
 * `catchall(z.unknown())` 而非 `.passthrough()`：前者在两个 major 版本上
 * 语义一致，后者是 v3 专属写法。
 */
export const CaseInput = z
  .object({ query: z.string().min(1) })
  .catchall(z.unknown());
export type CaseInput = z.infer<typeof CaseInput>;

/** 参考答案。`golden_answer` 供裁判/精确匹配；`reference_facts` 供数值保真。 */
export const CaseReference = z.object({
  golden_answer: z.string().optional(),
  reference_facts: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type CaseReference = z.infer<typeof CaseReference>;

/**
 * 业务标签（`metadata` jsonb）。
 *
 * 开放的键值集合：`difficulty` / `domain` / `priority` / `source`……
 * **只用于筛选与分组，永远不参与打分**——打分只走算子的 `config`。
 * 值限定标量：标签一旦允许嵌套对象，前端筛选器就无法通用渲染。
 */
export const CaseMetadata = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type CaseMetadata = z.infer<typeof CaseMetadata>;

/**
 * 导入时提交的单条 Case（尚未落库，故无 `id` / `seq`）。
 * `caseKey` 缺省时由导入器计算「规范化 input 的 hash」并回填。
 */
export const DatasetCaseInput = z.object({
  /**
   * 业务唯一键，跨版本对齐的唯一依据。
   * 缺失将导致 Badcase Diff 在 v1→v2 之间静默错配（product-overview §7.3-2）。
   */
  caseKey: z.string().min(1).optional(),
  input: CaseInput,
  reference: CaseReference.optional(),
  retrieval: RetrievalAnnotation.optional(),
  /** 业务标签；缺省视为 `{}`。 */
  metadata: CaseMetadata.optional(),
});
export type DatasetCaseInput = z.infer<typeof DatasetCaseInput>;

/** 落库后的 Case（只读）。与入参的差别：`caseKey` 必有、多了 id/seq。 */
export const DatasetCase = z.object({
  id: Uuid,
  datasetVersionId: Uuid,
  caseKey: z.string().min(1),
  /** 版本内从 0 起单调递增，用于稳定排序与分页游标。 */
  seq: z.number().int().min(0),
  input: CaseInput,
  reference: CaseReference.nullable(),
  retrieval: RetrievalAnnotation.nullable(),
  /** 业务标签，永不为 null（缺省为 `{}`，与数据库 `DEFAULT '{}'` 对齐）。 */
  metadata: CaseMetadata,
  createdAt: IsoDateTime,
});
export type DatasetCase = z.infer<typeof DatasetCase>;

// ---------------------------------------------------------------------------
// ED-01 · Dataset
// ---------------------------------------------------------------------------

/** `backflow` 对应 product-overview §7.2 的「回流」。 */
export const DatasetSource = z.enum(['import', 'mine', 'backflow']);
export type DatasetSource = z.infer<typeof DatasetSource>;

/** 创建评测集。名称在单工作区内唯一（`ux_datasets_workspace_name`）。 */
export const DatasetCreate = z.object({
  name: z
    .string()
    .max(120)
    .refine((v) => v.trim().length > 0, { message: '名称不可为空白' }),
  description: z.string().max(2000).optional(),
});
export type DatasetCreate = z.infer<typeof DatasetCreate>;

/**
 * 更新评测集：**仅限容器元数据**（名称 / 描述）。
 * 条目、版本号、指纹一律不可通过本契约改写（`ED-01` vs `ED-02` 边界）。
 */
export const DatasetUpdate = DatasetCreate.partial();
export type DatasetUpdate = z.infer<typeof DatasetUpdate>;

export const Dataset = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** 列表页展示用聚合值，非 `datasets` 表字段。 */
  latestVersionNo: z.number().int().min(0).nullable(),
  /** 最新版本的条目数；尚无版本时为 null。 */
  caseCount: z.number().int().min(0).nullable(),
});
export type Dataset = z.infer<typeof Dataset>;

// ---------------------------------------------------------------------------
// ED-02 · DatasetVersion
// ---------------------------------------------------------------------------

/** 首版锁定为 `"1"`；数据库侧另有 `CHECK (schema_version = '1')` 兜底。 */
export const DATASET_SCHEMA_VERSION = '1' as const;
export const DatasetSchemaVersion = z.literal(DATASET_SCHEMA_VERSION);
export type DatasetSchemaVersion = z.infer<typeof DatasetSchemaVersion>;

/**
 * 导入请求：**一次导入 = 一个新版本**。
 * 刻意不提供「追加到已有版本」的入口——那正是 `PT-2` 禁止的原地修改。
 */
export const DatasetVersionCreate = z.object({
  source: DatasetSource,
  note: z.string().max(2000).optional(),
  /**
   * 空版本会让所有算子均值为 NaN，故强制 `min(1)`。
   * 「先建空版本、稍后补数据」在本系统中不存在。
   */
  cases: z.array(DatasetCaseInput).min(1),
  /**
   * 客户端声明的期望指纹（可选）。与平台计算结果不一致即拒绝（`CONFLICT`），
   * 用于捕获传输截断这类静默数据损坏。
   */
  expectedContentHash: z.string().optional(),
});
export type DatasetVersionCreate = z.infer<typeof DatasetVersionCreate>;

export const DatasetVersion = z.object({
  id: Uuid,
  datasetId: Uuid,
  versionNo: z.number().int().min(1),
  schemaVersion: DatasetSchemaVersion,
  caseCount: z.number().int().min(0),
  /** 内容指纹：判断两次导入是否等价，等价则不产生新版本。 */
  contentHash: z.string(),
  source: DatasetSource,
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: IsoDateTime,
});
export type DatasetVersion = z.infer<typeof DatasetVersion>;

/** 版本详情：版本 + Case 预览（PG-05 区域 4「预览」）。 */
export const DatasetVersionDetail = DatasetVersion.extend({
  cases: z.array(DatasetCase),
  /** 供 UI 固定渲染「版本 v3 已发布，不可修改」的机器可读依据。 */
  immutable: z.literal(true),
});
export type DatasetVersionDetail = z.infer<typeof DatasetVersionDetail>;

// ---------------------------------------------------------------------------
// 导入校验结果（PG-05 上传面板）
// ---------------------------------------------------------------------------

export const ImportIssue = z.object({
  /** 1-based 行号，直接渲染为「第 47 行：…」。 */
  line: z.number().int().min(1),
  field: z.string().optional(),
  message: z.string(),
});
export type ImportIssue = z.infer<typeof ImportIssue>;

export const ImportValidationReport = z.object({
  okCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  issues: z.array(ImportIssue),
  /** 仅 true 时前端允许点击「生成新版本」。 */
  canCommit: z.boolean(),
});
export type ImportValidationReport = z.infer<typeof ImportValidationReport>;

// ---------------------------------------------------------------------------
// 检索可用性（PG-02 步骤 3 阻塞校验的数据来源）
// ---------------------------------------------------------------------------

/**
 * 某版本是否具备检索标注。
 * 对应 `database-schema.md` §2.3 的部分索引 `ix_dataset_cases_has_retrieval`。
 * 非 `ALL` / 非 `PARTIAL` 时，前端必须禁用三个检索算子并给出 PG-02 指定文案。
 */
export const RetrievalReadiness = z.object({
  /** 'NONE' ⇒ Recall@K / MRR / nDCG@K 全部不可用。 */
  state: z.enum(['ALL', 'PARTIAL', 'NONE']),
  annotatedCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
});
export type RetrievalReadiness = z.infer<typeof RetrievalReadiness>;
