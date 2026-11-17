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
// 连通性测试（PG-09「模型网关」Tab 的「测试连接」，`US-015`）
// ---------------------------------------------------------------------------

/**
 * `POST /api/providers/{providerId}/probe` 的请求体。
 *
 * **为什么请求体可以为空**：探针默认用**已保存**的厂商配置（含密文 Key）去测，
 * 这样用户不必为了「测一下」再输一次 Key。只有「换了 Key 想先试再存」时才传
 * `apiKeyOverride`——此时明文只走这一次请求，不落库、不回显、不写日志。
 *
 * `modelId` 可选：部分厂商的 `/models` 与 `/chat/completions` 需要显式模型名。
 */
export const ModelProviderProbeRequest = z.object({
  /** 临时覆盖 Key（明文）。省略 ⇒ 用库里已存的密文。 */
  apiKeyOverride: z.string().min(1).optional(),
  /** 临时覆盖 baseUrl。省略 ⇒ 用库里已存的。 */
  baseUrlOverride: z.string().url().optional(),
  /** 指定模型名做一次最小 chat 调用；省略 ⇒ 只测 `/models` 可达性。 */
  modelId: z.string().min(1).optional(),
});
export type ModelProviderProbeRequest = z.infer<typeof ModelProviderProbeRequest>;

/** 探针结果档位。 */
export const ModelProviderProbeStatus = z.enum([
  /** 连通且鉴权通过。 */
  'OK',
  /** 网络不可达 / DNS 失败 / 连接超时。 */
  'UNREACHABLE',
  /** 可达但鉴权失败（401 / 403）。 */
  'UNAUTHORIZED',
  /** 可达但上游 5xx。 */
  'UPSTREAM_ERROR',
  /** 可达但响应不符合 OpenAI 兼容形状。 */
  'BAD_RESPONSE',
]);
export type ModelProviderProbeStatus = z.infer<typeof ModelProviderProbeStatus>;

/**
 * 探针响应。
 *
 * **不含任何 Key 片段**：连 `apiKeyMasked` 都不回——探针的用途是「通不通」，
 * 把掩码再回一遍只会给日志多一处可泄露面。
 *
 * `latencyMs` 是**往返耗时**，用于 PG-09 的「连接延迟」展示；
 * `errorMessage` 只在非 `OK` 时有值，且必须是**上游原话的截断**，
 * 不得拼接本地路径、栈信息或任何凭据。
 */
export const ModelProviderProbeResult = z.object({
  status: ModelProviderProbeStatus,
  /** 往返耗时（毫秒）。`UNREACHABLE` 时为 `null`（没建立起连接）。 */
  latencyMs: z.number().int().min(0).nullable(),
  /** 上游原话截断（≤ 500 字符）；`OK` 时为 `null`。 */
  errorMessage: z.string().max(500).nullable(),
  /** 探针时刻，供 UI 显示「刚刚测过」。 */
  probedAt: IsoDateTime,
});
export type ModelProviderProbeResult = z.infer<typeof ModelProviderProbeResult>;

// ---------------------------------------------------------------------------
// 成本台账（PG-10，P1）
// ---------------------------------------------------------------------------

/**
 * 台账维度。与 PG-10 的「维度切换」一致。
 *
 * US-019 四维（SPEC-M4 Q5 裁定 = 按 US-019 执行）：时间 / 模型 / 评测集 / 发起人。
 * 时间维 = 按 UTC 日分桶的分组维度（`dimensionKey` 为 ISO 日期）；
 * 时间**窗口**由 `CostLedgerQuery.from/to` 表达，两者互补。
 */
export const CostLedgerDimension = z.enum(['time', 'model', 'dataset', 'user']);
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
  /**
   * T2 目标调用中端点未回传 usage 的 case 数（US-021：成本记 unknown）。
   * 这些 case 的成本按 0 计入上面各列，但语义是「未知」而非真实零成本——
   * 消费方（PG-10 页面 / CI）必须据此标注，不得把 0 读成「这单没花钱」。
   */
  unknownCostCases: z.number().int().min(0),
});
export type CostLedgerSummary = z.infer<typeof CostLedgerSummary>;

export const CostLedgerRow = z.object({
  /** 维度键：ISO 日期 / 模型 id / 评测集 id / 发起人。 */
  dimensionKey: z.string(),
  label: z.string(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costTarget: Money,
  costJudge: Money,
  costTotal: Money,
  runCount: z.number().int().min(0),
  /** 同 Summary.unknownCostCases，但归属到本维度分组。 */
  unknownCostCases: z.number().int().min(0),
});
export type CostLedgerRow = z.infer<typeof CostLedgerRow>;
