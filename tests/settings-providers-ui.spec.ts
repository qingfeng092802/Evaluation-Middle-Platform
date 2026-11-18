/**
 * `PG-09`「模型网关」Tab 的展示与提交口径（Batch 2 · 交付物 2 的 UI 半边）。
 *
 * 原文：「厂商、API Key 掩码保存（`WRITE_ONLY_FIELDS` 物理兑现）、
 * 输入/输出千 Token 单价、并发上限」。
 *
 * 路由层已经由 `tests/providers-admin.spec.ts` 钉住（真库 + 真 handler）。
 * 这里补的是**界面上那三处「写错了也照常渲染」**：
 *
 *  1. **编辑态的 Key 输入框必须是空的**，原 Key 只以掩码形式**旁注**。
 *     最容易的写错法是「把 `apiKeyMasked` 填进输入框的 value」——看起来体贴，
 *     实际后果是用户只改并发、点保存，提交体里就带上了 `apiKey: 'sk-••••1234'`，
 *     真 Key 被掩码覆盖，厂商**静默失效**。所以：输入框初值恒为空，
 *     掩码只出现在旁边的说明文字里。
 *  2. **留空 ⇒ 提交体里没有 `apiKey` 这个键**（不是空串）。空串会被契约的
 *     `min(1)` 拒成 400，用户看到「参数不合法」却不知道是自己没动 Key。
 *  3. **单价是数字、不是字符串拼出来的**，且必须走 `¥` 前缀 + 固定小数位，
 *     与 `lib/format` 的位数口径一致（`tabular-nums` 只保证等宽，不保证对齐）。
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ModelPrice, ModelProvider } from '@eval-platform/contracts';
import {
  EMPTY_PROVIDER_DRAFT,
  providerFormError,
  providerKeyHint,
  providerRequestBody,
  priceFormError,
  priceRequestBody,
  priceCell,
  concurrencyCell,
  emptyPriceDraft,
  type ProviderDraft,
  type PriceDraft,
} from '../lib/ui/providers.js';
import { NAV_SECTIONS, resolveActiveNav } from '../lib/ui/nav.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROVIDER: ModelProvider = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'DeepSeek 主账号',
  kind: 'openai_compatible',
  baseUrl: 'https://api.deepseek.com',
  apiKeyMasked: 'sk-••••1234',
  maxConcurrency: 4,
  isActive: true,
  createdAt: '2026-01-01T00:00:00+00:00',
  updatedAt: '2026-01-02T00:00:00+00:00',
};

const draft = (over: Partial<ProviderDraft> = {}): ProviderDraft => ({
  ...EMPTY_PROVIDER_DRAFT,
  name: '新厂商',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-live-abcdef1234',
  ...over,
});

// ---------------------------------------------------------------------------
// Key 的「只写不读」在界面上的形态
// ---------------------------------------------------------------------------

describe('API Key 输入框 · 只写不读', () => {
  it('新建态：提示说明这是首次填写，输入框初值为空', () => {
    expect(EMPTY_PROVIDER_DRAFT.apiKey).toBe('');
    expect(providerKeyHint(null)).toContain('保存后不可读取');
  });

  it('编辑态：提示里带掩码（让用户确认「是哪把 Key」），但明确「留空则不修改」', () => {
    const hint = providerKeyHint(PROVIDER);
    expect(hint).toContain('sk-••••1234');
    expect(hint).toContain('留空');
  });

  it('编辑态的草稿里 apiKey 恒为空串（掩码绝不当成 value 回填）', () => {
    // 这是本文件最重要的一条：`apiKeyMasked` 一旦被塞进输入框，
    // 「只改并发」就会把真 Key 覆盖成掩码字符串。
    expect(providerKeyHint(PROVIDER)).not.toBe(PROVIDER.apiKeyMasked);
  });
});

// ---------------------------------------------------------------------------
// 提交体：留空 ⇒ 没有这个键
// ---------------------------------------------------------------------------

describe('providerRequestBody · 新建 / 更新', () => {
  it('新建：带 apiKey，带默认并发与 type', () => {
    const body = providerRequestBody(draft(), 'create');
    expect(body['apiKey']).toBe('sk-live-abcdef1234');
    expect(body['name']).toBe('新厂商');
    expect(body['kind']).toBe('openai_compatible');
    expect(body['baseUrl']).toBe('https://api.example.com');
    expect(body['maxConcurrency']).toBe(4);
  });

  it('更新且 Key 留空 ⇒ 提交体里**没有** apiKey 键（不是空串）', () => {
    const body = providerRequestBody({ ...draft(), apiKey: '' }, 'update');
    expect('apiKey' in body, '空串会被契约 min(1) 拒成 400，用户看不懂').toBe(false);
  });

  it('更新且 Key 留白（只有空格）⇒ 同样不带 apiKey', () => {
    const body = providerRequestBody({ ...draft(), apiKey: '   ' }, 'update');
    expect('apiKey' in body).toBe(false);
  });

  it('更新且填了新 Key ⇒ 带上（覆盖语义）', () => {
    const body = providerRequestBody({ ...draft(), apiKey: 'sk-new-2222' }, 'update');
    expect(body['apiKey']).toBe('sk-new-2222');
  });

  it('baseUrl 留空 ⇒ 提交 null（清空自建网关地址是合法操作）', () => {
    const body = providerRequestBody({ ...draft(), baseUrl: '  ' }, 'update');
    expect(body['baseUrl']).toBeNull();
  });

  it('并发上限按数字提交，不是字符串', () => {
    const body = providerRequestBody({ ...draft(), maxConcurrency: '8' }, 'create');
    expect(body['maxConcurrency']).toBe(8);
    expect(typeof body['maxConcurrency']).toBe('number');
  });
});

describe('providerFormError · 提交前自检', () => {
  it('新建时 Key 为空 ⇒ 报错（Key 是必填）', () => {
    expect(providerFormError({ ...draft(), apiKey: '' }, 'create')).toContain('API Key');
  });

  it('更新时 Key 为空 ⇒ 不报错（留空即保留）', () => {
    expect(providerFormError({ ...draft(), apiKey: '' }, 'update')).toBeNull();
  });

  it('名称全空白 ⇒ 报错', () => {
    expect(providerFormError({ ...draft(), name: '   ' }, 'create')).toContain('名称');
  });

  it('并发上限不是正整数 ⇒ 报错', () => {
    expect(providerFormError({ ...draft(), maxConcurrency: '0' }, 'create')).toContain('并发');
    expect(providerFormError({ ...draft(), maxConcurrency: 'abc' }, 'create')).toContain('并发');
  });

  it('baseUrl 填了但不是 http(s) 地址 ⇒ 报错（不要等到服务端 400）', () => {
    expect(providerFormError({ ...draft(), baseUrl: '不是网址' }, 'create')).toContain('baseUrl');
  });

  it('全部合法 ⇒ null', () => {
    expect(providerFormError(draft(), 'create')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 单价区域
// ---------------------------------------------------------------------------

const PRICE: ModelPrice = {
  id: '22222222-2222-4222-8222-222222222222',
  modelProviderId: PROVIDER.id,
  modelId: 'deepseek-chat',
  displayName: 'DeepSeek Chat',
  inputPricePer1k: 0.001,
  outputPricePer1k: 0.002,
  currency: 'CNY',
  effectiveFrom: '2026-01-01T00:00:00+00:00',
  createdAt: '2026-01-01T00:00:00+00:00',
};

describe('单价单元格', () => {
  it('按货币符号 + 4 位小数（千 Token 单价常见到 1e-4）', () => {
    expect(priceCell(0.001, 'CNY')).toBe('¥0.0010');
    expect(priceCell(0.002, 'USD')).toBe('$0.0020');
  });

  it('0 也是有效单价（免费额度），显示 0 而不是 —', () => {
    expect(priceCell(0, 'CNY')).toBe('¥0.0000');
  });

  it('null ⇒ — （缺失 ≠ 0）', () => {
    expect(priceCell(null, 'CNY')).toBe('—');
  });

  it('并发上限是纯数字（列头已写明单位）', () => {
    expect(concurrencyCell(4)).toBe('4');
    expect(concurrencyCell(64)).toBe('64');
    expect(concurrencyCell(null)).toBe('—');
  });

  it('一整行真实单价按契约字段渲染（input/output 各自一套符号与位数）', () => {
    expect(priceCell(PRICE.inputPricePer1k, PRICE.currency)).toBe('¥0.0010');
    expect(priceCell(PRICE.outputPricePer1k, PRICE.currency)).toBe('¥0.0020');
  });
});

describe('priceRequestBody · 新增单价', () => {
  it('数值按 number 提交，currency 缺省 CNY', () => {
    const body = priceRequestBody({ ...emptyPriceDraft(PROVIDER.id), modelId: 'm1', displayName: 'M1', inputPricePer1k: '0.001', outputPricePer1k: '0.002' });
    expect(body['inputPricePer1k']).toBe(0.001);
    expect(body['currency']).toBe('CNY');
    expect(body['modelProviderId']).toBe(PROVIDER.id);
  });

  it('生效时点留空 ⇒ 不带 effectiveFrom（服务端取 now()）', () => {
    const body = priceRequestBody({ ...emptyPriceDraft(PROVIDER.id), modelId: 'm1', displayName: 'M1', inputPricePer1k: '1', outputPricePer1k: '2' });
    expect('effectiveFrom' in body).toBe(false);
  });

  it('填了生效时点 ⇒ 转成 ISO 串带上', () => {
    const body = priceRequestBody({
      ...emptyPriceDraft(PROVIDER.id),
      modelId: 'm1',
      displayName: 'M1',
      inputPricePer1k: '1',
      outputPricePer1k: '2',
      effectiveFrom: '2026-03-01T00:00',
    });
    expect(String(body['effectiveFrom'])).toMatch(/^2026-03-01T/);
  });
});

describe('priceFormError · 提交前自检', () => {
  const base: PriceDraft = {
    ...emptyPriceDraft(PROVIDER.id),
    modelId: 'm1',
    displayName: 'M1',
    inputPricePer1k: '1',
    outputPricePer1k: '2',
  };

  it('模型标识为空 ⇒ 报错', () => {
    expect(priceFormError({ ...base, modelId: ' ' })).toContain('模型');
  });

  it('单价为负 ⇒ 报错', () => {
    expect(priceFormError({ ...base, inputPricePer1k: '-1' })).toContain('单价');
  });

  it('单价不是数字 ⇒ 报错', () => {
    expect(priceFormError({ ...base, outputPricePer1k: 'abc' })).toContain('单价');
  });

  it('没选厂商 ⇒ 报错', () => {
    expect(priceFormError({ ...base, modelProviderId: '' })).toContain('厂商');
  });

  it('全部合法 ⇒ null', () => {
    expect(priceFormError(base)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 页面与导航：PG-09 已经「真的上线」了
// ---------------------------------------------------------------------------

describe('/settings 页面 · 从占位变成真页面', () => {
  it('页面是客户端组件（要发起请求、要有表单状态）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'settings', 'page.tsx'), 'utf8');
    expect(src).toContain("'use client'");
  });

  it('有「模型网关」Tab 与外链的读写调用（不再只有一句占位说明）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'settings', 'page.tsx'), 'utf8');
    expect(src).toContain('模型网关');
    expect(src).toContain('apiPost');
    expect(src).toContain('apiPatch');
    expect(src).toContain('/api/providers');
    expect(src).toContain('/api/prices');
  });

  it('不再渲染 PlaceholderPage（占位页只留给 M3 / M4 的页面）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'settings', 'page.tsx'), 'utf8');
    expect(src).not.toContain('PlaceholderPage');
    expect(src).not.toContain('noticeKey');
  });

  it('页面不得硬编码任何凭据或假厂商数据（mockData 禁令）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'settings', 'page.tsx'), 'utf8');
    expect(src).not.toMatch(/sk-[a-z0-9]{10,}/i);
    expect(src).not.toContain('mockData');
  });
});

describe('导航 · /settings 已解除置灰', () => {
  it('模型网关 Tab 上线后，/settings 是可点项而不是 P1 占位', () => {
    const all = NAV_SECTIONS.flatMap((s) => s.items);
    const settings = all.find((i) => i.href === '/settings');
    expect(settings, '侧栏里必须有 /settings').toBeDefined();
    expect(settings?.disabled, '/settings 已交付，不该再置灰').not.toBe(true);
  });

  it('进入 /settings 时高亮该项', () => {
    expect(resolveActiveNav('/settings')).toBe('/settings');
    expect(resolveActiveNav('/settings/providers')).toBe('/settings');
  });

  it('/evaluators 已解除置灰（M4 Batch 4 交付 PG-07）', () => {
    const evaluators = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.href === '/evaluators');
    expect(evaluators).toBeDefined();
    expect(evaluators?.disabled).toBeUndefined();
  });

  it('分区个数仍是 4（不得因为加了页面就多一个分区）', () => {
    expect(NAV_SECTIONS).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 横幅里的「去配置」现在是真链接
// ---------------------------------------------------------------------------

describe('PG-01 未配凭证横幅 · 「去配置」指向真实页面', () => {
  it('横幅源码里 /settings 是可达链接（不再是就地展开的说明）', async () => {
    const src = await readFile(resolve(ROOT, 'components', 'shell', 'provider-banner.tsx'), 'utf8');
    expect(src).toContain('/settings');
    expect(src, 'PG-09 已上线，不该再说「不在 M1 交付范围」').not.toContain('不在 M1 交付范围');
  });
});
