/**
 * 准出条件 1：**API Key 零明文泄露**（Batch 2 · 交付物 2 / 5）。
 *
 * 原文：「任何读取路径只返回 `apiKeyMasked`」。
 *
 * ## 为什么这条必须写成「全路径扫描」而不是「字段名对得上」
 *
 * 断言「响应里有 `apiKeyMasked`」几乎必然通过，却什么也没证明 —— 泄露的形态是
 * **多出**一个字段，不是少一个。因此这里反过来断言：把响应序列化成字符串，
 * 只要密文里出现过一段真实存在的哨兵串，就判红。
 *
 * 哨兵串的做法：种子里写入一个**结构上不可能自然出现**的密文
 * （`SENTINEL-CIPHERTEXT-...`），再断言它不出现在任何响应体里。
 * 这比「字段名等于 apiKeyMasked」强得多：将来谁把整行 `SELECT *` 透传出去，
 * 这条测试立刻变红，而字段名断言不会。
 *
 * ## 覆盖的读取路径
 *
 *  1. `GET /api/providers`（列表）
 *  2. `GET /api/providers/{id}`（单条 —— 若存在）
 *  3. `POST /api/providers/{id}/probe` 的响应（探针**连掩码都不回**）
 *  4. 执行期内部读取 `getProviderForExecution()` 的返回形状（不该叫 ModelProvider）
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect, databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { closeDb } from '../db/schema/index.js';
import { runSeed } from '../scripts/seed.js';
import { getProviderForExecution, listProviderViews } from '../db/repo/modelProviders.js';
import * as providersRoute from '../app/api/providers/route.js';
import * as providerProbeRoute from '../app/api/providers/[providerId]/probe/route.js';

const BASE = 'http://localhost:3000';

/** 结构上不可能自然出现的哨兵：出现在响应里就一定是泄露。 */
const SENTINEL = 'SENTINEL-CIPHERTEXT-MUST-NOT-LEAK-7f3a';

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

/** 把响应体序列化成字符串，用于哨兵扫描。 */
async function bodyText(res: Response): Promise<string> {
  return JSON.stringify(await res.json());
}

let client: Client;
let providerId: string;

beforeEach(async () => {
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  await resetDatabase(databaseUrl());
  await runSeed({ silent: true });

  client = await connect();
  // 把种子里那把 fixture provider 的密文换成哨兵串，并刻意让明文等于哨兵，
  // 这样「密文泄露」与「明文回显」两种翻车形态都能被同一段哨兵捕获。
  //
  // `is_active = true` 是必需的：M2 · Batch 2 起种子里这条厂商**默认停用**
  // （交付物 6），而本文件要验证「执行期读取确实能拿到密文」这条路径 ——
  // 停用的厂商在 `getProviderForExecution` 里会被过滤掉，拿不到密文就测不到
  // 「读到了密文但只回可回传视图」这件事。启用只是让夹具具备可测状态，
  // 与「摘除默认路径」不冲突（摘除说的是**种子默认态**）。
  const row = await client.query<{ id: string }>(
    `UPDATE model_providers
        SET api_key_ciphertext = $1,
            api_key_masked     = 'sk-••••7f3a',
            is_active          = true
      RETURNING id`,
    [SENTINEL],
  );
  providerId = row.rows[0]?.id as string;
});

afterAll(async () => {
  if (client) await client.end();
  await closeDb();
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  await resetDatabase(databaseUrl());
  await runSeed({ silent: true });
  await closeDb();
});

describe('准出 1 · API Key 零明文泄露', () => {
  it('GET /api/providers 不回密文，只回掩码', async () => {
    const res = await providersRoute.GET(req('/api/providers'));
    expect(res.status).toBe(200);
    const text = await bodyText(res);

    expect(text, '列表接口把密文透传出去了').not.toContain(SENTINEL);
    expect(text, '列表接口应以掩码形式暴露 apiKeyMasked').toContain('sk-••••7f3a');
    // 反证：连字段名都不该出现，否则说明有人开始往契约里加只读 Key 字段
    expect(text).not.toContain('apiKeyCiphertext');
    expect(text).not.toContain('api_key_ciphertext');
  });

  it('GET /api/providers 的每一项都不含任何未声明字段', async () => {
    const res = await providersRoute.GET(req('/api/providers'));
    const body = (await res.json()) as { items: Record<string, unknown>[] };

    const allowed = new Set([
      'id',
      'name',
      'kind',
      'baseUrl',
      'apiKeyMasked',
      'maxConcurrency',
      'isActive',
      'createdAt',
      'updatedAt',
    ]);
    for (const item of body.items) {
      for (const key of Object.keys(item)) {
        expect(allowed.has(key), `响应里出现了契约未声明的字段：${key}`).toBe(true);
      }
    }
  });

  it('仓储层 listProviderViews 的返回对象里没有密文字段', async () => {
    const views = await listProviderViews();
    for (const v of views) {
      expect(Object.keys(v)).not.toContain('apiKeyCiphertext');
      expect(JSON.stringify(v)).not.toContain(SENTINEL);
    }
  });

  it('执行期读取可以拿到密文，但返回类型不含 apiKeyMasked（用途隔离）', async () => {
    // 这是唯一允许读密文的路径，给 worker 构造 Authorization 头用。
    const exec = await getProviderForExecution(providerId);
    expect(exec).not.toBeNull();
    expect(exec?.apiKey).toBe(SENTINEL);
    // 反向约束：它不是 API 响应体，所以不该带展示用字段
    expect(Object.keys(exec ?? {})).not.toContain('apiKeyMasked');
  });

  it('POST /api/providers/{id}/probe 的响应连掩码都不回', async () => {
    const res = await providerProbeRoute.POST(
      req(`/api/providers/${providerId}/probe`, { method: 'POST', body: {} }),
      params({ providerId }),
    );
    const text = await bodyText(res);

    expect(text, '探针响应泄露了密文').not.toContain(SENTINEL);
    expect(text, '探针响应不该回掩码（多一处可泄露面）').not.toContain('sk-••••7f3a');
  });
});
