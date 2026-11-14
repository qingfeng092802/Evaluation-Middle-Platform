/**
 * `PG-09`「模型网关」Tab 的写路径（Batch 2 · 交付物 2）。
 *
 * 原文：「厂商、API Key 掩码保存（`WRITE_ONLY_FIELDS` 物理兑现）、
 * 输入/输出千 Token 单价、并发上限」。
 *
 * ## 这个文件在钉什么
 *
 * 1. **Key 一旦写进去，就再也读不回来**。不是「响应里有没有 `apiKeyMasked`」
 *    （那条几乎必然通过），而是：写入的明文必须能从 `getProviderForExecution()`
 *    还原成可用凭据（否则 worker 拿密文当 Bearer），同时任何响应体只回掩码。
 *    两条一起断言，才能证明「加密后立即弃用」不是一句注释。
 * 2. **PATCH 省略 `apiKey` 必须保留原 Key**。契约写的是「省略 ⇒ 保留」，
 *    最容易的写错法是 `SET api_key_ciphertext = NULL` 或写成空串 ——
 *    那会让一个配好的厂商在「只改并发上限」时静默失效。
 * 3. **调价只增行不改行**（`MP-2`）。同一 `(provider, model)` 第二次报价必须
 *    留下两行，`getEffectivePrice` 取新那行。行数断言是这条唯一可靠的证据：
 *    金额可以因为取错行而恰好相等，行数不会。
 *
 * ## 为什么用真库
 *
 * 「保留原 Key」的语义全在 SQL 的 `COALESCE` / 动态 `SET` 里；
 * mock 掉仓储等于把被测的那条语句也 mock 掉。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  connect,
  databaseUrl,
  dropAndRecreateSchema,
  migrate,
  resetDatabase,
} from '../db/migrate.js';
import { closeDb } from '../db/schema/index.js';
import { runSeed } from '../scripts/seed.js';
import { getProviderForExecution } from '../db/repo/modelProviders.js';
import { getEffectivePrice } from '../db/repo/modelPrices.js';
import * as providersRoute from '../app/api/providers/route.js';
import * as providerRoute from '../app/api/providers/[providerId]/route.js';
import * as pricesRoute from '../app/api/prices/route.js';

const BASE = 'http://localhost:3000';

/** 只在测试进程内存在的加密口令（不是真实凭据，也不入库）。 */
const TEST_SECRET = 'test-only-at-rest-secret-0123456789abcdef';

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : {
          body: JSON.stringify(init.body),
          headers: { 'content-type': 'application/json' },
        }),
  });
}

function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

let client: Client;

/** 建一家厂商，返回响应体。 */
async function createProvider(over: Record<string, unknown> = {}): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await providersRoute.POST(
    req('/api/providers', {
      method: 'POST',
      body: {
        name: '测试厂商',
        kind: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:9999',
        apiKey: 'sk-live-abcdef1234',
        maxConcurrency: 4,
        ...over,
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(() => {
  process.env['PROVIDER_KEY_SECRET'] = TEST_SECRET;
});

afterAll(async () => {
  delete process.env['PROVIDER_KEY_SECRET'];
  if (client) await client.end();
  await closeDb();
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  await resetDatabase(databaseUrl());
  await runSeed({ silent: true });
  await closeDb();
});

beforeEach(async () => {
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  await resetDatabase(databaseUrl());
  await runSeed({ silent: true });
  client = await connect();
});

// ---------------------------------------------------------------------------
// POST /api/providers
// ---------------------------------------------------------------------------

describe('POST /api/providers · 新增厂商与密钥', () => {
  it('返回 201，且响应体是 ModelProvider 契约（无 apiKey、无任何密文）', async () => {
    const { status, body } = await createProvider();

    expect(status).toBe(201);
    expect(body['apiKeyMasked']).toBe('sk-••••1234');
    expect(body['name']).toBe('测试厂商');
    expect(body['maxConcurrency']).toBe(4);
    expect(body['isActive']).toBe(true);

    const text = JSON.stringify(body);
    expect(text, '响应里出现了 apiKey 明文').not.toContain('sk-live-abcdef1234');
    expect(text).not.toContain('apiKeyCiphertext');
    expect(text).not.toContain('api_key_ciphertext');
    expect(Object.keys(body).sort()).toEqual(
      [
        'apiKeyMasked',
        'baseUrl',
        'createdAt',
        'id',
        'isActive',
        'kind',
        'maxConcurrency',
        'name',
        'updatedAt',
      ].sort(),
    );
  });

  it('密文列存的不是明文（配置了口令就必须加密）', async () => {
    const { body } = await createProvider({ apiKey: 'sk-secret-value-9988' });
    const row = await client.query<{ api_key_ciphertext: string; api_key_masked: string }>(
      `SELECT api_key_ciphertext, api_key_masked FROM model_providers WHERE id = $1`,
      [body['id']],
    );
    const stored = row.rows[0]?.api_key_ciphertext ?? '';
    expect(stored, '密文列里躺着明文').not.toContain('sk-secret-value-9988');
    expect(stored).not.toBe('sk-secret-value-9988');
    expect(row.rows[0]?.api_key_masked).toBe('sk-••••9988');
  });

  it('写入的 Key 能被执行期读回成可用凭据（否则 worker 会拿密文当 Bearer）', async () => {
    const { body } = await createProvider({ apiKey: 'sk-roundtrip-4242' });
    const exec = await getProviderForExecution(String(body['id']));
    expect(exec).not.toBeNull();
    expect(exec?.apiKey).toBe('sk-roundtrip-4242');
    expect(exec?.baseUrl).toBe('http://127.0.0.1:9999');
  });

  it('同名厂商重复创建 ⇒ 409（数据库唯一约束翻译成业务语义，不是 500）', async () => {
    await createProvider();
    const second = await createProvider();
    expect(second.status).toBe(409);
    expect((second.body['error'] as { code?: string } | undefined)?.code).toBe('CONFLICT');
  });

  it('名称全空白 ⇒ 400（契约的 refine 不是摆设）', async () => {
    const { status, body } = await createProvider({ name: '   ' });
    expect(status).toBe(400);
    expect((body['error'] as { code?: string } | undefined)?.code).toBe('VALIDATION_FAILED');
  });

  it('apiKey 为空 ⇒ 400', async () => {
    const { status } = await createProvider({ apiKey: '' });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/providers/{providerId}
// ---------------------------------------------------------------------------

describe('PATCH /api/providers/{providerId} · 更新厂商', () => {
  it('省略 apiKey ⇒ 原 Key 保留（只改并发上限不该让厂商失效）', async () => {
    const created = await createProvider({ apiKey: 'sk-keep-me-7777' });
    const id = String(created.body['id']);

    const res = await providerRoute.PATCH(
      req(`/api/providers/${id}`, { method: 'PATCH', body: { maxConcurrency: 8 } }),
      params({ providerId: id }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['maxConcurrency']).toBe(8);
    // 掩码未变 ⇒ 说明原 Key 还在
    expect(body['apiKeyMasked']).toBe('sk-••••7777');

    const exec = await getProviderForExecution(id);
    expect(exec?.apiKey, '省略 apiKey 之后原 Key 丢了').toBe('sk-keep-me-7777');
  });

  it('提供 apiKey ⇒ 覆盖，掩码随之更新', async () => {
    const created = await createProvider({ apiKey: 'sk-old-1111' });
    const id = String(created.body['id']);

    const res = await providerRoute.PATCH(
      req(`/api/providers/${id}`, { method: 'PATCH', body: { apiKey: 'sk-new-2222' } }),
      params({ providerId: id }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['apiKeyMasked']).toBe('sk-••••2222');
    expect(JSON.stringify(body)).not.toContain('sk-new-2222');
    expect((await getProviderForExecution(id))?.apiKey).toBe('sk-new-2222');
  });

  it('isActive=false ⇒ 停用后执行期读不到（摘除默认路径的同一语义）', async () => {
    const created = await createProvider();
    const id = String(created.body['id']);

    const res = await providerRoute.PATCH(
      req(`/api/providers/${id}`, { method: 'PATCH', body: { isActive: false } }),
      params({ providerId: id }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['isActive']).toBe(false);
    expect(await getProviderForExecution(id)).toBeNull();
  });

  it('厂商不存在 ⇒ 404（不是 500，也不是静默成功）', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const res = await providerRoute.PATCH(
      req(`/api/providers/${ghost}`, { method: 'PATCH', body: { name: 'x' } }),
      params({ providerId: ghost }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// POST /api/prices · GET /api/prices
// ---------------------------------------------------------------------------

async function createPrice(over: Record<string, unknown> = {}): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const provider = await client.query<{ id: string }>(
    `SELECT id FROM model_providers ORDER BY created_at ASC LIMIT 1`,
  );
  const res = await pricesRoute.POST(
    req('/api/prices', {
      method: 'POST',
      body: {
        modelProviderId: provider.rows[0]?.id,
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        inputPricePer1k: 0.001,
        outputPricePer1k: 0.002,
        currency: 'CNY',
        ...over,
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/prices · 新增单价', () => {
  it('201 建一行，数值按 numeric 精度回传（不是字符串）', async () => {
    const { status, body } = await createPrice();
    expect(status).toBe(201);
    expect(body['inputPricePer1k']).toBe(0.001);
    expect(body['outputPricePer1k']).toBe(0.002);
    expect(body['currency']).toBe('CNY');
  });

  it('调价只增行不改行：同 (厂商, 模型) 第二次报价留下两行，取价取新那行', async () => {
    const provider = await client.query<{ id: string }>(
      `SELECT id FROM model_providers ORDER BY created_at ASC LIMIT 1`,
    );
    const providerId = provider.rows[0]?.id as string;

    const old = await createPrice({
      inputPricePer1k: 1,
      outputPricePer1k: 2,
      effectiveFrom: '2026-01-01T00:00:00Z',
    });
    expect(old.status).toBe(201);

    const now = await createPrice({ inputPricePer1k: 3, outputPricePer1k: 4 });
    expect(now.status).toBe(201);

    const count = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_prices WHERE model_provider_id = $1 AND model_id = 'deepseek-chat'`,
      [providerId],
    );
    expect(count.rows[0]?.n, '调价把旧行改掉了（历史成本将无法对账）').toBe('2');

    const effective = await getEffectivePrice(providerId, 'deepseek-chat');
    expect(effective?.inputPricePer1k).toBe(3);
    expect(effective?.outputPricePer1k).toBe(4);
  });

  it('同一 (厂商, 模型, 生效时点) 重复 ⇒ 409（唯一键不是摆设）', async () => {
    const at = '2026-03-01T00:00:00Z';
    expect((await createPrice({ effectiveFrom: at })).status).toBe(201);
    const dup = await createPrice({ effectiveFrom: at });
    expect(dup.status).toBe(409);
  });

  it('单价为负 ⇒ 400（契约与数据库 CHECK 同时把关）', async () => {
    expect((await createPrice({ inputPricePer1k: -1 })).status).toBe(400);
  });

  it('厂商不存在 ⇒ 404（外键违规不该变成 500）', async () => {
    const res = await createPrice({ modelProviderId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/prices · 单价列表', () => {
  it('按 modelProviderId 过滤，且返回 {items, page}', async () => {
    await createPrice({ modelId: 'm-a' });

    const other = await client.query<{ id: string }>(
      `INSERT INTO model_providers (name, kind, api_key_ciphertext, api_key_masked, is_active)
       VALUES ('另一家', 'openai_compatible', 'x', 'x-••••x', false) RETURNING id`,
    );
    await client.query(
      `INSERT INTO model_prices (model_provider_id, model_id, display_name,
                                 input_price_per_1k, output_price_per_1k)
       VALUES ($1, 'm-b', 'm-b', 1, 2)`,
      [other.rows[0]?.id],
    );

    const all = await pricesRoute.GET(req('/api/prices'));
    const allBody = (await all.json()) as { items: { modelId: string }[]; page: unknown };
    expect(all.status).toBe(200);
    // 不带过滤 ⇒ 全部行（种子里已经给 fixture 厂商报过价，所以不能断言「恰好两条」）
    const allIds = allBody.items.map((i) => i.modelId);
    expect(allIds).toContain('m-a');
    expect(allIds).toContain('m-b');
    expect(allBody.page).toBeDefined();

    const filtered = await pricesRoute.GET(
      req(`/api/prices?modelProviderId=${String(other.rows[0]?.id)}`),
    );
    const filteredBody = (await filtered.json()) as { items: { modelId: string }[] };
    expect(filteredBody.items.map((i) => i.modelId)).toEqual(['m-b']);
  });
});
