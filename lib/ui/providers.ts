/**
 * `PG-09`「模型网关」Tab 的表单口径（纯函数）。
 *
 * 页面只负责渲染与发请求，所有「什么该提交、什么不该提交」的判断都在这里，
 * 这样它们能被单测钉住 —— 表单逻辑写错的典型症状不是报错，而是**静默地提交了
 * 一份看起来合理的错东西**（最严重的是把掩码当 Key 提交，见下）。
 *
 * ## 三条不变量
 *
 *  1. **Key 输入框初值恒为空。** 编辑已有厂商时，原 Key 只以掩码出现在**旁注**里。
 *     若把 `apiKeyMasked` 填进 `value`，用户「只改并发」点保存就会提交
 *     `apiKey: 'sk-••••1234'`，真 Key 被掩码覆盖 —— 厂商从此静默失效，
 *     而界面上一切正常。
 *  2. **留空 ⇒ 提交体里根本不存在 `apiKey` 这个键。** 不是空串：契约是 `.min(1)`，
 *     空串会被拒成 400，用户看到「参数不合法」却不知道自己只是没动 Key。
 *  3. **单价 / 并发以 `number` 提交。** 表单控件给的是字符串，转换必须在这一层发生，
 *     且只此一次 —— 散在 JSX 里就迟早有一处忘了转。
 *
 * 本文件不 import React，也不发请求。
 */
import type { ModelPrice, ModelProvider } from '@eval-platform/contracts';
import { EMPTY } from '../format/index.js';

/** 单价与并发在界面上都是「字符串进、数字出」。 */
export interface ProviderDraft {
  readonly name: string;
  readonly kind: ModelProvider['kind'];
  /** 空串 ⇒ 官方直连（提交时转 `null`）。 */
  readonly baseUrl: string;
  /** **永远**从空串开始，编辑态也不例外（见文件头第 1 条）。 */
  readonly apiKey: string;
  readonly maxConcurrency: string;
  readonly isActive: boolean;
}

/** 新建表单的初值。 */
export const EMPTY_PROVIDER_DRAFT: ProviderDraft = {
  name: '',
  kind: 'openai_compatible',
  baseUrl: '',
  apiKey: '',
  maxConcurrency: '4',
  isActive: true,
};

/**
 * Key 输入框旁的说明文字。
 *
 * 新建时告诉用户「写进去就再也读不回来」——这是契约层面的不对称，不是 UI 的毛病。
 * 编辑时把掩码放在这句说明里，让用户能确认「我改的是哪把 Key」，
 * 同时说清「留空 = 不修改」，避免他以为必须重填。
 */
export function providerKeyHint(provider: ModelProvider | null): string {
  if (provider === null) {
    return '首次填写。保存后不可读取（只显示掩码），请确认无误再保存。';
  }
  return `当前 Key：${provider.apiKeyMasked}。留空则不修改；填写新值将覆盖原 Key。`;
}

/** 提交模式：新建要求 Key 必填，更新允许留空。 */
export type ProviderFormMode = 'create' | 'update';

function trimmed(v: string): string {
  return v.trim();
}

/** `baseUrl` 只接受 http(s)：本地回显网关也是 http，不需要更复杂的校验。 */
function isHttpUrl(v: string): boolean {
  return /^https?:\/\/\S+$/i.test(v);
}

/**
 * 表单草稿 → `POST /api/providers` / `PATCH /api/providers/{id}` 的请求体。
 *
 * 两条「省略」都体现在这里：
 *  - `apiKey` 空白 ⇒ **不带该键**（更新语义 = 保留原值）；
 *  - `baseUrl` 空白 ⇒ `null`（更新语义 = 清空；新建时服务端按「官方直连」处理）。
 */
export function providerRequestBody(
  draft: ProviderDraft,
  mode: ProviderFormMode,
): Record<string, unknown> {
  const key = trimmed(draft.apiKey);
  const baseUrl = trimmed(draft.baseUrl);

  const body: Record<string, unknown> = {
    name: trimmed(draft.name),
    kind: draft.kind,
    baseUrl: baseUrl === '' ? null : baseUrl,
    maxConcurrency: Number(draft.maxConcurrency),
  };

  // 新建时 Key 必填（空值由 providerFormError 拦下），
  // 更新时留空 = 不改 —— 此时**连键都不能有**，否则服务端会把它当成覆盖。
  if (key !== '') body['apiKey'] = key;

  // `isActive` 只属于更新语义：`ModelProviderCreate` 里根本没有这个字段
  // （新建即启用，由数据库 DEFAULT 决定），多传只会被契约静默 strip 掉。
  if (mode === 'update') body['isActive'] = draft.isActive;

  return body;
}

/**
 * 提交前自检；返回第一处错误的中文说明，`null` 表示可提交。
 *
 * 判据与契约**不做重复实现**：这里只拦「填了但明显不合法」的（负数、非数字、
 * 非 http 网址），其余交给服务端契约。重复实现规则会让两侧迟早分叉。
 */
export function providerFormError(draft: ProviderDraft, mode: ProviderFormMode): string | null {
  if (trimmed(draft.name) === '') return '厂商名称不能为空';
  if (mode === 'create' && trimmed(draft.apiKey) === '') return 'API Key 不能为空';

  const conc = Number(draft.maxConcurrency);
  if (!Number.isInteger(conc) || conc <= 0 || conc > 64) {
    return '并发上限必须是 1–64 之间的整数';
  }

  const baseUrl = trimmed(draft.baseUrl);
  if (baseUrl !== '' && !isHttpUrl(baseUrl)) {
    return 'baseUrl 必须是以 http:// 或 https:// 开头的地址';
  }

  return null;
}

// ---------------------------------------------------------------------------
// 单价
// ---------------------------------------------------------------------------

export interface PriceDraft {
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly inputPricePer1k: string;
  readonly outputPricePer1k: string;
  readonly currency: ModelPrice['currency'];
  /** `datetime-local` 的值（`YYYY-MM-DDTHH:mm`）；空串 ⇒ 立即生效。 */
  readonly effectiveFrom: string;
}

/** 新增单价的初值。`providerId` 为空表示「还没选厂商」。 */
export function emptyPriceDraft(providerId: string): PriceDraft {
  return {
    modelProviderId: providerId,
    modelId: '',
    displayName: '',
    inputPricePer1k: '',
    outputPricePer1k: '',
    currency: 'CNY',
    effectiveFrom: '',
  };
}

/**
 * `datetime-local` 的值 → ISO 串。
 *
 * 输入没有时区（`2026-03-01T00:00`）。**按 UTC 解释**：若交给 `new Date()` 的
 * 本地时区解释，同一份配置在不同时区的机器上会落成不同时刻 ——
 * 而「生效时点」是成本对账的锚点，差 8 小时就可能把一次调价算到前一天的运行上。
 */
function localInputToIso(v: string): string {
  const withSeconds = v.length === 16 ? `${v}:00` : v;
  return new Date(`${withSeconds}Z`).toISOString();
}

/** 单价草稿 → `POST /api/prices` 的请求体。 */
export function priceRequestBody(draft: PriceDraft): Record<string, unknown> {
  const effectiveFrom = trimmed(draft.effectiveFrom);
  return {
    modelProviderId: draft.modelProviderId,
    modelId: trimmed(draft.modelId),
    displayName: trimmed(draft.displayName),
    inputPricePer1k: Number(draft.inputPricePer1k),
    outputPricePer1k: Number(draft.outputPricePer1k),
    currency: draft.currency,
    // 留空 ⇒ 不带该键，交给数据库 DEFAULT now()
    ...(effectiveFrom === '' ? {} : { effectiveFrom: localInputToIso(effectiveFrom) }),
  };
}

/** 单价提交前自检；`null` 表示可提交。 */
export function priceFormError(draft: PriceDraft): string | null {
  if (trimmed(draft.modelProviderId) === '') return '请先选择厂商';
  if (trimmed(draft.modelId) === '') return '模型标识不能为空';
  if (trimmed(draft.displayName) === '') return '展示名不能为空';

  for (const [label, raw] of [
    ['输入', draft.inputPricePer1k],
    ['输出', draft.outputPricePer1k],
  ] as const) {
    const n = Number(trimmed(raw));
    if (trimmed(raw) === '' || Number.isNaN(n) || n < 0) {
      return `${label}单价必须是 ≥ 0 的数字`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 单元格展示
// ---------------------------------------------------------------------------

const CURRENCY_SIGN: Readonly<Record<string, string>> = { CNY: '¥', USD: '$' };

/**
 * 千 Token 单价：`符号 + 4 位小数`。
 *
 * 4 位不是随手取的：国产模型常见 `0.001`/千 token，只显示 2 位会全变成 `0.00`。
 * `0` 是**有效**单价（免费额度），因此不能套用「假值一律 `—`」的规则 ——
 * 只有 `null`（没有报价）才是缺失。
 */
export function priceCell(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return EMPTY;
  const sign = CURRENCY_SIGN[currency] ?? '';
  return `${sign}${value.toFixed(4)}`;
}

/** 并发上限：纯数字（列头已写明单位）。`null` ⇒ `—`。 */
export function concurrencyCell(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  return String(value);
}

/** 厂商类型的中文标签（与契约枚举一一对应）。 */
export function providerKindLabel(kind: ModelProvider['kind']): string {
  switch (kind) {
    case 'openai_compatible':
      return 'OpenAI 兼容';
    case 'anthropic':
      return 'Anthropic';
    case 'litellm':
      return 'LiteLLM 中转';
  }
}

/** 启用状态的中文标签。 */
export function providerActiveLabel(isActive: boolean): string {
  return isActive ? '启用中' : '已停用';
}
