/**
 * 交付物 6：**摘除 fixture 网关默认路径**（Batch 2）。
 *
 * 原文：「种子 provider 置 `is_active=false`，`RunPreflight` 不再因它返回
 * `hasProviderCredentials=true`」。
 *
 * ## 为什么必须摘
 *
 * M1 的整条演示链（`npm run dev:all` → `127.0.0.1:8787` 回显网关）依赖种子里那条
 * `is_active=true` 的 fixture 厂商。M2 引入真实多厂商网关后，这条默认路径会变成
 * **静默的假成功**：用户以为跑的是真模型，其实打的是本地回显。
 * 更糟的是 `RunPreflight.hasProviderCredentials` 会因此恒为 `true`，
 * 「尚未配置网关凭证」的横幅永远不出现 —— 用户失去了「我没配」这个唯一提示。
 *
 * ## 为什么不直接删掉那行
 *
 * 历史 run 的 `config_snapshot` 引着它的 id。删了，回看历史 run 的厂商信息就断了。
 * 所以是「停用」而不是「删除」。
 *
 * ## 这条测试要钉住的三件事
 *
 *  1. 种子里 fixture provider 的 `is_active = false`；
 *  2. 只跑种子时 `RunPreflight.hasProviderCredentials === false`，且 blockers 里有
 *     `BLOCKED_NO_PROVIDER_CREDENTIALS`；
 *  3. 一旦有**真实**厂商启用，`hasProviderCredentials` 立刻变 `true`
 *     （证明摘的是「默认路径」而不是把能力关掉）。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { FIXTURE_PROVIDER } from '../db/seed/fixture-provider.js';
import * as preflightRoute from '../app/api/runs/preflight/route.js';

const BASE = 'http://localhost:3000';

function req(path: string): NextRequest {
  return new NextRequest(`${BASE}${path}`, { method: 'GET' });
}

let client: Client;
let datasetVersionId: string;

beforeEach(async () => {
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  await resetDatabase(databaseUrl());
  await runSeed({ silent: true });

  client = await connect();
  // 取种子里那个数据集的 v1，供 preflight 路由使用。
  const v = await client.query<{ id: string }>(
    `SELECT id FROM dataset_versions ORDER BY version_no ASC LIMIT 1`,
  );
  datasetVersionId = v.rows[0]?.id as string;
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

describe('交付物 6 · fixture 网关不再是可用凭证来源', () => {
  it('种子里 fixture provider 的 is_active 为 false', async () => {
    const r = await client.query<{ is_active: boolean }>(
      `SELECT is_active FROM model_providers WHERE name = $1`,
      [FIXTURE_PROVIDER.name],
    );
    expect(r.rows[0], '种子必须仍然写入这一行（历史 run 的 vendor 快照指向它）').toBeDefined();
    expect(r.rows[0]?.is_active, 'fixture provider 必须停用，否则默认路径又活过来了').toBe(false);
  });

  it('种子常量本身也是 isActive: false（防止有人只改 SQL 不改常量）', () => {
    expect(FIXTURE_PROVIDER.isActive).toBe(false);
  });

  it('只有种子时 preflight 返回 hasProviderCredentials=false 且带 NO_PROVIDER 阻塞', async () => {
    const res = await preflightRoute.GET(
      req(`/api/runs/preflight?datasetVersionId=${datasetVersionId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasProviderCredentials: boolean;
      canStart: boolean;
      blockers: string[];
    };

    expect(body.hasProviderCredentials, 'fixture 停用后不应再有可用凭证').toBe(false);
    expect(body.blockers).toContain('BLOCKED_NO_PROVIDER_CREDENTIALS');
    expect(body.canStart).toBe(false);
  });

  it('一旦有真实厂商启用，hasProviderCredentials 立刻变 true（能力没被关掉）', async () => {
    await client.query(
      `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked, is_active)
       VALUES ('真实厂商', 'openai_compatible', 'https://api.example.com', 'cipher-x', 'sk-••••xxxx', true)`,
    );

    const res = await preflightRoute.GET(
      req(`/api/runs/preflight?datasetVersionId=${datasetVersionId}`),
    );
    const body = (await res.json()) as {
      hasProviderCredentials: boolean;
      blockers: string[];
    };

    expect(body.hasProviderCredentials).toBe(true);
    expect(body.blockers).not.toContain('BLOCKED_NO_PROVIDER_CREDENTIALS');
  });

  it('停用的厂商即使有 base_url 也不能在执行期被取到', async () => {
    // `getProviderForExecution` 带 `AND is_active = true`：这是「停用」真正生效的地方。
    const { getProviderForExecution } = await import('../db/repo/modelProviders.js');
    const r = await client.query<{ id: string }>(
      `SELECT id FROM model_providers WHERE name = $1`,
      [FIXTURE_PROVIDER.name],
    );
    const exec = await getProviderForExecution(r.rows[0]?.id as string);
    expect(exec, '停用的厂商不得被 worker 取到').toBeNull();
  });
});
