/**
 * M5 Batch 2 —— Webhook 入站接收（验签 / 幂等 / 白名单 / 映射 / 取消请求）。
 *
 * 架构：两个真实 HTTP 服务器（`http.createServer`，真实 socket 往返）：
 *  1. **平台挂载服务器**：把 `webhookRoute.POST` 等真实 Route Handler 挂到本地端口
 *     ——Mock GitHub 的 POST 走真实 HTTP 打进来，命中真实 handler + 真实测试库；
 *  2. **Mock GitHub 发射服务器**：`POST /emit` 收 {secret, payload, deliveryId,
 *     signatureMode} → 以 HMAC-SHA256 签名 → **转发真实 POST** 给平台挂载服务器
 *     ——即「本地 Mock GitHub 服务器发真实 POST 请求」（过夜铁律 3：零真实外网）。
 *
 * 覆盖：验签失败 401 且零落账 / 重放 200 DEDUPED / 未绑定 202 / opened 触发
 * （占位 run）/ closed 跳过 / synchronize 置 cancel_requested / API 级泄密扫描
 * （集成详情 + 404 错误响应零凭据）。
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GithubIntegration,
  WebhookResponse,
} from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld, type CompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

import * as webhookRoute from '../app/api/integrations/github/webhook/route.js';
import * as integrationRoute from '../app/api/integrations/github/route.js';
import * as integrationDetailRoute from '../app/api/integrations/github/[integrationId]/route.js';
import * as rulesRoute from '../app/api/pr-trigger-rules/route.js';

const DB_URL = process.env['DATABASE_URL'];
const SECRET = 'sim-webhook-secret-0f1b';
const PEM_SENTINEL = 'SENTINEL-PEM-MUST-NOT-LEAK-3c7a';
const SECRET_SENTINEL = 'SENTINEL-SECRET-MUST-NOT-LEAK-9f1b';
let savedSecret: string | undefined;

// ---------------------------------------------------------------------------
// 平台挂载服务器：真实 Route Handler + 真实测试库
// ---------------------------------------------------------------------------

let platformUrl = '';

function toNextRequest(req: http.IncomingMessage, raw: string): NextRequest {
  const url = `http://127.0.0.1${req.url ?? '/'}`;
  const hasBody = req.method === 'POST' || req.method === 'PATCH';
  return new NextRequest(url, {
    method: req.method ?? 'GET',
    headers: req.headers as Record<string, string>,
    ...(hasBody ? { body: raw } : {}),
  });
}

async function mountRoute(req: http.IncomingMessage, raw: string): Promise<Response | null> {
  const nextReq = toNextRequest(req, raw);
  if (req.url === '/api/integrations/github/webhook' && req.method === 'POST') {
    return webhookRoute.POST(nextReq);
  }
  if (req.url === '/api/integrations/github' && req.method === 'POST') {
    return integrationRoute.POST(nextReq);
  }
  if (req.url === '/api/pr-trigger-rules' && req.method === 'POST') {
    return rulesRoute.POST(nextReq);
  }
  if (req.url?.startsWith('/api/integrations/github/') && req.method === 'GET') {
    const integrationId = req.url.split('/')[4] ?? '';
    return integrationDetailRoute.GET(nextReq, { params: Promise.resolve({ integrationId }) });
  }
  return null;
}

let ghServer: http.Server;
let ghPort = 0;

beforeAll(async () => {
  // GitHub 私钥密文需要口令（provider-key-cipher 拒绝明文落库）——测试内自设，
  // afterAll 还原（provider-key-cipher.spec 同款惯例）。
  savedSecret = process.env['PROVIDER_KEY_SECRET'];
  process.env['PROVIDER_KEY_SECRET'] = 'sim-master-secret-for-tests';
  const platform = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void mountRoute(req, Buffer.concat(chunks).toString('utf8'))
        .then(async (r) => {
          if (r === null) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: { code: 'NOT_MOUNTED', message: 'no route' } }));
            return;
          }
          res.statusCode = r.status;
          const text = await r.text();
          res.setHeader('content-type', 'application/json');
          res.end(text);
        })
        .catch((e: unknown) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: String(e) }));
        });
    });
  });
  await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', () => resolve()));
  // 稳定化：默认 5s keepAliveTimeout 会与串行用例间隔竞态（复用中的 socket 被
  // 服务器关闭 → ECONNRESET → 偶发 500）。测试场景直接禁用 keep-alive 超时。
  platform.keepAliveTimeout = 0;
  platformUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;

  // Mock GitHub 发射服务器：/emit 收签名材料 → 真实 POST 平台
  ghServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const { payload, secret, deliveryId, event, signatureMode, target } = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as {
        payload: unknown;
        secret: string;
        deliveryId: string;
        event: string;
        signatureMode: 'valid' | 'tampered';
        target: string;
      };
      const raw = JSON.stringify(payload);
      const mac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      // 默认 = 真实签名；显式 'tampered' 才发全零签名（伪造场景）
      const signature =
        signatureMode === 'tampered' ? `sha256=${'0'.repeat(64)}` : `sha256=${mac}`;
      void fetch(`${target}/api/integrations/github/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-event': event,
          'x-github-delivery': deliveryId,
        },
        body: raw,
      })
        .then(async (r) => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ platformStatus: r.status, platformBody: await r.json().catch(() => null) }));
        })
        .catch((e: unknown) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: String(e) }));
        });
    });
  });
  await new Promise<void>((resolve) => ghServer.listen(0, '127.0.0.1', () => resolve()));
  ghServer.keepAliveTimeout = 0;
  ghPort = (ghServer.address() as AddressInfo).port;
});

function githubEmit(input: {
  payload: unknown;
  secret: string;
  deliveryId: string;
  event: string;
  signatureMode?: 'valid' | 'tampered';
}): Promise<{ platformStatus: number; platformBody: unknown }> {
  return fetch(`http://127.0.0.1:${String(ghPort)}/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, target: platformUrl }),
  }).then(async (r) => (await r.json()) as { platformStatus: number; platformBody: unknown });
}

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  ghServer.close();
  await closeDb();
  await restoreSeed(databaseUrl());
  if (savedSecret === undefined) delete process.env['PROVIDER_KEY_SECRET'];
  else process.env['PROVIDER_KEY_SECRET'] = savedSecret;
});

function req(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function createIntegrationOverHttp(name: string, pem: string, secret: string): Promise<string> {
  const res = await integrationRoute.POST(
    req('/api/integrations/github', {
      method: 'POST',
      body: {
        name,
        appId: '123456',
        installationId: '987654',
        privateKey: pem,
        webhookSecret: secret,
        repos: [{ owner: 'o', repo: 'r' }],
      },
    }),
  );
  expect(res.status).toBe(201);
  return GithubIntegration.parse(await res.json()).id;
}

async function addBranchRule(integrationId: string, datasetId: string): Promise<void> {
  const res = await rulesRoute.POST(
    req('/api/pr-trigger-rules', {
      method: 'POST',
      body: { integrationId, repoFullName: 'o/r', targetBranch: 'main', datasetId },
    }),
  );
  expect(res.status).toBe(201);
}

async function deliveryRows(deliveryId: string): Promise<Array<{ processed_status: string; run_id: string | null }>> {
  const r = await getPool().query<{ processed_status: string; run_id: string | null }>(
    `SELECT processed_status, run_id FROM webhook_deliveries WHERE delivery_id = $1`,
    [deliveryId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------

describe('M5 Batch 2 · Webhook 入站（真实 HTTP：Mock GitHub → 平台挂载服务器）', () => {
  let w: CompareWorld;
  let integrationId: string;

  beforeEach(async () => {
    w = await buildCompareWorld({ name: 'webhook-in', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });
    integrationId = await createIntegrationOverHttp('主仓库集成', `PEM-${PEM_SENTINEL}`, SECRET);
    await addBranchRule(integrationId, w.datasetId);
  });

  it('验签失败 → 401，且不落任何 delivery 记录（fail-closed）', async () => {
    const deliveryId = 'sig-fail-1';
    const out = await githubEmit({
      payload: { action: 'opened', number: 1, repository: { full_name: 'o/r' }, pull_request: { head: { sha: 'a1b2c3d4e5f6', ref: 'feat' }, base: { ref: 'main' }, labels: [], html_url: 'https://github.com/o/r/pull/1' } },
      secret: 'wrong-secret-entirely',
      deliveryId,
      event: 'pull_request',
      signatureMode: 'valid',
    });
    expect(out.platformStatus).toBe(401);
    const err = (out.platformBody as { error?: { code?: string } }).error;
    expect(err?.code).toBe('UNAUTHORIZED');
    expect(await deliveryRows(deliveryId)).toHaveLength(0);
  });

  it('opened 合法签名 → 200 TRIGGERED（占位触发，runId=null），delivery 落账', async () => {
    const deliveryId = 'opened-1';
    const out = await githubEmit({
      payload: { action: 'opened', number: 2, repository: { full_name: 'o/r' }, pull_request: { head: { sha: 'b1b2c3d4e5f6', ref: 'feat' }, base: { ref: 'main' }, labels: [], html_url: 'https://github.com/o/r/pull/2' } },
      secret: SECRET,
      deliveryId,
      event: 'pull_request',
    });
    expect(out.platformStatus, JSON.stringify(out.platformBody)).toBe(200);
    console.log('[dbg] platformBody =', JSON.stringify(out.platformBody));
    const body = WebhookResponse.parse(out.platformBody);
    expect(body.status).toBe('TRIGGERED');
    expect(body.deduped).toBe(false);
    expect(body.runId).toBeNull();
    const rows = await deliveryRows(deliveryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processed_status).toBe('TRIGGERED');
  });

  it('重放（同 delivery_id）→ 200 DEDUPED，不重复触发、不重复落账', async () => {
    const deliveryId = 'replay-1';
    const payload = { action: 'opened', number: 3, repository: { full_name: 'o/r' }, pull_request: { head: { sha: 'c1b2c3d4e5f6', ref: 'feat' }, base: { ref: 'main' }, labels: [], html_url: 'https://github.com/o/r/pull/3' } };
    const first = await githubEmit({ payload, secret: SECRET, deliveryId, event: 'pull_request' });
    expect(first.platformStatus).toBe(200);
    const second = await githubEmit({ payload, secret: SECRET, deliveryId, event: 'pull_request' });
    expect(second.platformStatus).toBe(200);
    expect(WebhookResponse.parse(second.platformBody)).toMatchObject({ status: 'DEDUPED', deduped: true });
    expect(await deliveryRows(deliveryId)).toHaveLength(1);
  });

  it('未绑定仓库 → 202 SKIPPED_UNBOUND（202 接受但留痕不触发）', async () => {
    const deliveryId = 'unbound-1';
    const out = await githubEmit({
      payload: { action: 'opened', number: 4, repository: { full_name: 'other/repo' }, pull_request: { head: { sha: 'd1b2c3d4e5f6', ref: 'feat' }, base: { ref: 'main' }, labels: [], html_url: 'https://github.com/other/repo/pull/4' } },
      secret: SECRET,
      deliveryId,
      event: 'pull_request',
    });
    expect(out.platformStatus).toBe(202);
    expect(WebhookResponse.parse(out.platformBody)).toMatchObject({ status: 'SKIPPED_UNBOUND' });
    const rows = await deliveryRows(deliveryId);
    expect(rows[0]!.processed_status).toBe('SKIPPED_UNBOUND');
  });

  it('closed → 200 SKIPPED_CLOSED（不触发评测）', async () => {
    const deliveryId = 'closed-1';
    const out = await githubEmit({
      payload: { action: 'closed', number: 5, repository: { full_name: 'o/r' }, pull_request: { head: { sha: 'e1b2c3d4e5f6', ref: 'feat' }, base: { ref: 'main' }, labels: [], html_url: 'https://github.com/o/r/pull/5' } },
      secret: SECRET,
      deliveryId,
      event: 'pull_request',
    });
    expect(out.platformStatus, JSON.stringify(out.platformBody)).toBe(200);
    expect(WebhookResponse.parse(out.platformBody)).toMatchObject({ status: 'SKIPPED_CLOSED' });
    expect((await deliveryRows(deliveryId))[0]!.processed_status).toBe('SKIPPED_CLOSED');
  });

  it('synchronize → 置同 PR 旧 RUNNING run 的 cancel_requested=true（Q3 协作式取消请求）', async () => {
    // 旧 head_sha 的 run：造一个 RUNNING run，并把「上一次 opened 的 TRIGGERED delivery」指到它
    const running = await getPool().query<{ id: string }>(
      `INSERT INTO eval_runs
         (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
          runner_version, created_by, total_cases, status)
       SELECT 'sim-old-head', dv.id, tv.id, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', 0, 'RUNNING'
         FROM dataset_versions dv
         JOIN dataset_versions dv2 ON dv2.dataset_id = dv.dataset_id
         JOIN target_versions tv ON tv.id = (SELECT target_version_id FROM eval_runs WHERE dataset_version_id = dv2.id LIMIT 1)
        WHERE dv2.id = $1
        GROUP BY dv.id, tv.id
        LIMIT 1
       RETURNING id`,
      [w.currentRunId ? (await getPool().query<{ dataset_version_id: string }>('SELECT dataset_version_id FROM eval_runs WHERE id = $1', [w.currentRunId])).rows[0]!.dataset_version_id : ''],
    );
    const oldRunId = running.rows[0]!.id;
    const priorDeliveryId = 'sync-prior-opened';
    await getPool().query(
      `INSERT INTO webhook_deliveries
         (delivery_id, integration_id, event, signature_verified, processed_status, run_id, payload_summary)
       VALUES ($1, $2, 'pull_request', true, 'TRIGGERED', $3, '{"repo_full_name":"o/r","pr_number":9,"head_sha":"old0sha1"}'::jsonb)`,
      [priorDeliveryId, integrationId, oldRunId],
    );

    const out = await githubEmit({
      payload: { action: 'synchronize', number: 9, repository: { full_name: 'o/r' }, pull_request: { head: { sha: 'f1b2c3d4e5f6', ref: 'feat' }, base: { ref: 'main' }, labels: [], html_url: 'https://github.com/o/r/pull/9' } },
      secret: SECRET,
      deliveryId: 'sync-1',
      event: 'pull_request',
    });
    expect(out.platformStatus, JSON.stringify(out.platformBody)).toBe(200);
    expect(WebhookResponse.parse(out.platformBody)).toMatchObject({ status: 'TRIGGERED' });

    const row = await getPool().query<{ cancel_requested: boolean; status: string }>(
      `SELECT cancel_requested, status FROM eval_runs WHERE id = $1`,
      [oldRunId],
    );
    expect(row.rows[0]!.cancel_requested).toBe(true);
    expect(row.rows[0]!.status).toBe('RUNNING'); // 只置请求位；实际终止由 worker 协作式完成（Batch 2 不杀进程）
  }, 60_000);

  it('API 级泄密扫描：创建/详情/404 错误响应零凭据明文，只有布尔位', async () => {
    const leakIntegrationId = await createIntegrationOverHttp(
      '泄密扫描集成',
      `-----BEGIN RSA PRIVATE KEY-----\n${PEM_SENTINEL}\n-----END RSA PRIVATE KEY-----`,
      SECRET_SENTINEL,
    );
    const detail = await fetch(`${platformUrl}/api/integrations/github/${leakIntegrationId}`).then(
      async (r) => ({ status: r.status, text: await r.text() }),
    );
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain(PEM_SENTINEL);
    expect(detail.text).not.toContain(SECRET_SENTINEL);
    expect(JSON.parse(detail.text)).toMatchObject({ hasPrivateKey: true, hasWebhookSecret: true });

    const missing = await fetch(`${platformUrl}/api/integrations/github/00000000-0000-4000-8000-000000000000`).then(
      async (r) => ({ status: r.status, text: await r.text() }),
    );
    expect(missing.status).toBe(404);
    expect(missing.text).not.toContain(PEM_SENTINEL);
    expect(missing.text).not.toContain(SECRET_SENTINEL);
  });
});
