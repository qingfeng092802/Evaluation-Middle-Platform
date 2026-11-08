/**
 * Target / TargetVersion 契约（`ED-05`）。
 *
 * 事实源：
 *  - `docs/facts/database-schema.md` §2.6–2.7
 *  - `docs/facts/product-overview.md` §4（T1/T2/T3）与 §4.2（快照规则）
 *  - `docs/facts/pages-and-flows.md` PG-06
 *
 * 关键约束：T1 与 T2 的字段**不可互相污染**。
 * 数据库用 `ck_target_versions_t1/t2` 两条 CHECK 保证；
 * 这里用 `z.discriminatedUnion` 保证——不写判别键就无法通过校验，
 * 从而让「kind='t1_prompt' 却只填了 endpoint」这类半残行在 API 层即被拦截。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { IsoDateTime, JsonObject, Uuid } from './common.js';

/** 与 `ck_targets_kind` / `ck_target_versions_kind` 一一对应。 */
export const TargetKind = z.enum(['t1_prompt', 't2_http']);
export type TargetKind = z.infer<typeof TargetKind>;

// ---------------------------------------------------------------------------
// T1 · 平台内执行（P0）
// ---------------------------------------------------------------------------

/**
 * Prompt 模板中引用变量一律写作 `{{input}}` / `{{context}}` 形式。
 * 此处只做存在性提示，不做语法校验（模板引擎在 worker 侧落定）。
 */
export const T1TargetConfig = z.object({
  kind: z.literal('t1_prompt'),
  /** 引用 `model_providers.id`。凭证本身永不出现在契约中，只出现掩码值。 */
  modelProviderId: Uuid,
  /** 网关侧的模型标识，如 `gpt-4o-mini`、`deepseek-chat`。 */
  modelId: z.string().min(1),
  promptTemplate: z.string().min(1),
  /** `numeric(3,2)`，数据库侧 CHECK 0 ≤ t ≤ 2。 */
  temperature: z.number().min(0).max(2),
  /** 必须为正整数；数据库侧 CHECK > 0。 */
  maxTokens: z.number().int().positive(),
  /** 厂商额外参数（`top_p` / `stop` 等）透传，不参与校验。 */
  params: JsonObject.optional(),
});
export type T1TargetConfig = z.infer<typeof T1TargetConfig>;

// ---------------------------------------------------------------------------
// T2 · 外部 HTTP 回调（P1）
// ---------------------------------------------------------------------------

/** 字段映射：把平台侧变量写入请求体的路径（如 `messages.0.content`）。 */
export const FieldMapping = z.record(z.string(), z.string());
export type FieldMapping = z.infer<typeof FieldMapping>;

/**
 * T2 配置。
 *
 * **`authHeader` 只在写入侧出现一次，读取侧永不返回**（`technical-solution.md` §4）：
 * 落库进 `auth_header_ciphertext`，任何响应体只回 `hasAuthHeader: boolean`。
 * 这一非对称是本契约故意为之——如果四处都能读到明文，加密就失去了意义。
 */
export const T2TargetConfig = z.object({
  kind: z.literal('t2_http'),
  endpointUrl: z.string().url(),
  /** 写入专用。读取侧请用 `T2TargetConfigRedacted`。 */
  authHeader: z.string().min(1).optional(),
  requestMapping: FieldMapping,
  responseMapping: FieldMapping,
});
export type T2TargetConfig = z.infer<typeof T2TargetConfig>;

/** 读取侧的 T2 配置：无 `authHeader`，只有「有没有配」这一位信息。 */
export const T2TargetConfigRedacted = T2TargetConfig.omit({ authHeader: true }).extend({
  hasAuthHeader: z.boolean(),
});
export type T2TargetConfigRedacted = z.infer<typeof T2TargetConfigRedacted>;

// ---------------------------------------------------------------------------
// 版本与容器
// ---------------------------------------------------------------------------

/** 写入侧的 Target 版本配置（判别联合）。 */
export const TargetVersionConfig = z.discriminatedUnion('kind', [
  T1TargetConfig,
  T2TargetConfig,
]);
export type TargetVersionConfig = z.infer<typeof TargetVersionConfig>;

/** 读取侧的 Target 版本配置（判别联合，T2 已脱敏）。 */
export const TargetVersionConfigView = z.discriminatedUnion('kind', [
  T1TargetConfig,
  T2TargetConfigRedacted,
]);
export type TargetVersionConfigView = z.infer<typeof TargetVersionConfigView>;

/**
 * 创建 Target = 同时创建 v1。
 * 刻意没有"空 Target"状态：一个没有版本的 Target 无法被选进 PG-02，
 * 允许它存在只会让列表里出现点不动的行。
 */
export const TargetCreate = z.object({
  name: z
    .string()
    .max(120)
    .refine((v) => v.trim().length > 0, { message: '名称不可为空白' }),
  config: TargetVersionConfig,
});
export type TargetCreate = z.infer<typeof TargetCreate>;

/**
 * 更新 Target = **生成新版本**（PG-06 文案「保存后将生成 v2，历史运行仍引用 v1」）。
 * 名称变化只改容器；`config` 变化才产生新版本号。
 */
export const TargetUpdate = z.object({
  name: z
    .string()
    .max(120)
    .refine((v) => v.trim().length > 0, { message: '名称不可为空白' })
    .optional(),
  config: TargetVersionConfig.optional(),
});
export type TargetUpdate = z.infer<typeof TargetUpdate>;

export const TargetVersion = z.object({
  id: Uuid,
  targetId: Uuid,
  versionNo: z.number().int().min(1),
  config: TargetVersionConfigView,
  createdBy: z.string(),
  createdAt: IsoDateTime,
});
export type TargetVersion = z.infer<typeof TargetVersion>;

export const Target = z.object({
  id: Uuid,
  name: z.string(),
  kind: TargetKind,
  /** P0 期只会是 t1_prompt；T2 选项在 PG-06 中置灰标注「P1 支持」。 */
  currentVersionNo: z.number().int().min(0),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** 列表页展示用：最近版本的关键配置摘要。 */
  currentVersion: TargetVersion.nullable(),
});
export type Target = z.infer<typeof Target>;

/**
 * P0 期 T2 是否可选。
 *
 * 单点开关，而不是散落在前端各处的 `if (kind === 't2_http')`：
 * P1 接入 T2 时只改这一处。
 */
export const TARGET_T2_ENABLED = false as const;
