/**
 * M5 Batch 4 —— 投递历史查询路由（PG-09「GitHub 集成」区块的数据面）。
 *
 * `GET /api/integrations/github/{integrationId}/deliveries`：0022 只追加账本的
 * 倒序读取（received_at DESC）；集成不存在 → 404。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GithubDeliveryListResponse } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { restoreSeed } from './support/fixtures.js';

import * as integrationRoute from '../app/api/integrations/github/route.js';
import * as deliveriesRoute from '../app/api/integrations/github/[integrationId]/deliveries/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';
let savedSecret: string | undefined;

beforeAll(async () => {
  // 集成创建走 AES-256-GCM 加密落库——口令缺失即抛错（provider-key-cipher 纪律）
  savedSecret = process.env['PROVIDER_KEY_SECRET'];
  process.env['PROVIDER_KEY_SECRET'] = 'sim-master-secret-for-tests';
});

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
  if (savedSecret === undefined) delete process.env['PROVIDER_KEY_SECRET'];
  else process.env['PROVIDER_KEY_SECRET'] = savedSecret;
});

describe('GET /api/integrations/github/{integrationId}/deliveries', () => {
  it('倒序返回投递账（summary 白名单形状过契约 parse）', async () => {
    await integrationRoute.POST(
      req('/api/integrations/github', {
        method: 'POST',
        body: {
          name: '投递历史集成',
          appId: '123456',
          installationId: '987654',
          privateKey: 'PEM',
          webhookSecret: 'sim-webhook-secret-0f1b',
          repos: [{ owner: 'o', repo: 'r' }],
        },
      }),
    );
    const integrationId = (
      await getPool().query<{ id: string }>('SELECT id FROM github_integrations LIMIT 1')
    ).rows[0]!.id;
    await getPool().query(
      `INSERT INTO webhook_deliveries
         (delivery_id, integration_id, event, signature_verified, processed_status, payload_summary, received_at)
       VALUES
         ('d-old', $1, 'pull_request', true, 'SKIPPED_UNBOUND',
          '{"repo_full_name":"o/r","pr_number":1,"head_sha":"aaa","action":"opened"}', '2026-11-19T10:00:00Z'),
         ('d-new', $1, 'pull_request', true, 'TRIGGERED',
          '{"repo_full_name":"o/r","pr_number":2,"head_sha":"bbb","action":"synchronize"}', '2026-11-19T11:00:00Z')`,
      [integrationId],
    );

    const res = await deliveriesRoute.GET(nextGet(integrationId), params({ integrationId }));
    expect(res.status).toBe(200);
    const body = GithubDeliveryListResponse.parse(await res.json());
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.deliveryId).toBe('d-new'); // 倒序：新的在前
    expect(body.items[0]!.summary).toMatchObject({ repo_full_name: 'o/r', pr_number: 2, action: 'synchronize' });
    expect('processed_status' in (body.items[1] as object)).toBe(false); // 读取形状是 camelCase
    expect(body.items[1]!.processedStatus).toBe('SKIPPED_UNBOUND');
  });

  it('集成不存在 → 404', async () => {
    const missing = await deliveriesRoute.GET(
      nextGet('00000000-0000-4000-8000-000000000000'),
      params({ integrationId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(missing.status).toBe(404);
  });
});

function nextGet(integrationId: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/integrations/github/${integrationId}/deliveries`);
}
