/**
 * ModelProvider / ModelPrice 契约（PG-09「模型网关」Tab，`US-015`，P0）。
 *
 * 事实源：
 *  - `docs/facts/database-schema.md` §2.4–2.5
 *  - `docs/facts/technical-solution.md` TS-2「🔒 成本口径红线」
 *  - `docs/facts/pages-and-flows.md` PG-09
 *
 * 两条不可协商的红线：
 *
 *  1. **API Key 只写不读。** 落 `api_key_ciphertext`，任何响应只回 `apiKeyMasked`。
 *     契约里存在 `ModelProviderCreate.apiKey` 而 `ModelProvider` 里**没有**它，
 *     这一非对称就是加密的全部意义。
 *
 *  2. **成本只由 `model_prices` 计算，永不采信 LiteLLM 的成本统计。**
 *     因此本文件不含任何 `cost` / `usage` 字段——单价是输入，成本是算出来的，
 *     让上游把成本传进来就是让单一事实源失效。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { Currency, IsoDateTime, Money, Uuid } from './common.js';

// ---------------------------------------------------------------------------
// 厂商
// ---------------------------------------------------------------------------

/**
 * 厂商类型。
 *
 *  - `openai_compatible`：绝大多数国产厂商（DeepSeek / 通义 / 智谱 …）
 *  - `anthropic`：协议不同，单独一档
 *  - `litellm`：统一经 LiteLLM Proxy 中转（TS-2 定稿方案）
 */
export const ModelProviderKind = z.enum(['openai_compatible', 'anthropic', 'litellm']);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

/**
 * 创建厂商。
 *
 * `apiKey` 是**明文入参**，服务端加密后立即弃用明文，绝不回显、绝不写日志。
 * 禁止把本对象直接 `JSON.stringify` 进日志——`工程规则` §9。
 */
export const ModelProviderCreate = z.object({
  name: z
    .string()
    .max(120)
    .refine((v) => v.trim().length > 0, { message: '厂商名称不可为空白' }),
  kind: ModelProviderKind,
  /** 自建/代理网关地址；官方直连可留空。 */
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1),
  /** 该厂商的并发上限，worker 侧据此分桶限流。数据库 CHECK > 0。 */
  maxConcurrency: z.number().int().positive().max(64).default(4),
});
export type ModelProviderCreate = z.infer<typeof ModelProviderCreate>;

/**
 * 更新厂商。
 *
 * `apiKey` 省略 ⇒ 保留原 Key；提供 ⇒ 覆盖。
 * **不存在"读出原 Key 再回填"的路径**，所以 UI 只能显示掩码 + 「重新输入」。
 */
export const ModelProviderUpdate = z.object({
  name: z
    .string()
    .max(120)
    .refine((v) => v.trim().length > 0, { message: '厂商名称不可为空白' })
    .optional(),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(1).optional(),
  maxConcurrency: z.number().int().positive().max(64).optional(),
  isActive: z.boolean().optional(),
});
export type ModelProviderUpdate = z.infer<typeof ModelProviderUpdate>;

/** 读取视图：**无 `apiKey`，无 `apiKeyCiphertext`**。 */
export const ModelProvider = z.object({
  id: Uuid,
  name: z.string(),
  kind: ModelProviderKind,
  baseUrl: z.string().nullable(),
  /** 形如 `sk-••••3f2a`，仅供用户确认"我配的是哪把 Key"。 */
  apiKeyMasked: z.string(),
  maxConcurrency: z.number().int().positive(),
  isActive: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ModelProvider = z.infer<typeof ModelProvider>;

// ---------------------------------------------------------------------------
// 单价
// ---------------------------------------------------------------------------

/**
 * 新增单价行。
 *
 * **调价不改行、只增行**：`effectiveFrom` 区分生效时点。
 * 历史 EvalRun 因此永远对得上当时的单价（与不可变哲学一致）。
 */
export const ModelPriceCreate = z.object({
  modelProviderId: Uuid,
  /** 厂商侧模型标识，如 `deepseek-chat`。 */
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  /** `numeric(18,8)`，每 1K token 单价。 */
  inputPricePer1k: Money,
  outputPricePer1k: Money,
  currency: Currency.default('CNY'),
  /** 缺省 = 立即生效。 */
  effectiveFrom: IsoDateTime.optional(),
});
export type ModelPriceCreate = z.infer<typeof ModelPriceCreate>;

export const ModelPrice = z.object({
  id: Uuid,
  modelProviderId: Uuid,
  modelId: z.string(),
  displayName: z.string(),
  inputPricePer1k: Money,
  outputPricePer1k: Money,
  currency: Currency,
  effectiveFrom: IsoDateTime,
  createdAt: IsoDateTime,
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * 成本计算入参。
 *
 * 这是**唯一**允许把 token 数变成钱的入口。
 * 实现约束（`technical-solution.md` OPEN-3）：落库前用 numeric 计算，禁止浮点累加。
 */
export const CostInput = z.object({
  inputPricePer1k: Money,
  outputPricePer1k: Money,
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
});
export type CostInput = z.infer<typeof CostInput>;

/**
 * 成本 = (tokensIn × inputPrice + tokensOut × outputPrice) / 1000。
 *
 * 用 `toFixed(8)` 截断而非保留全精度：与 `numeric(18,8)` 的标度对齐，
 * 避免 ORM 往返时出现 `1.0000000000000002` 这类噪声。
 */
export function computeCost(x: CostInput): number {
  const raw =
    (x.tokensIn * x.inputPricePer1k + x.tokensOut * x.outputPricePer1k) / 1000;
  return Number(raw.toFixed(8));
}

// ---------------------------------------------------------------------------
// 成本台账（PG-10，P1）
// ---------------------------------------------------------------------------

/** 台账维度。与 PG-10 的「维度切换」一致。 */
export const CostLedgerDimension = z.enum(['model', 'dataset', 'user']);
export type CostLedgerDimension = z.infer<typeof CostLedgerDimension>;

export const CostLedgerQuery = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
  dimension: CostLedgerDimension.default('model'),
});
export type CostLedgerQuery = z.infer<typeof CostLedgerQuery>;

export const CostLedgerSummary = z.object({
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  /** 分列（OPEN-3）——台账必须能回答"钱花在被测模型上还是裁判上"。 */
  costTarget: Money,
  costJudge: Money,
  costTotal: Money,
  runCount: z.number().int().min(0),
});
export type CostLedgerSummary = z.infer<typeof CostLedgerSummary>;

export const CostLedgerRow = z.object({
  /** 维度键：模型 id / 评测集名 / 发起人。 */
  dimensionKey: z.string(),
  label: z.string(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costTarget: Money,
  costJudge: Money,
  costTotal: Money,
  runCount: z.number().int().min(0),
});
export type CostLedgerRow = z.infer<typeof CostLedgerRow>;
