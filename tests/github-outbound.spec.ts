/**
 * M5 Batch 3 —— GitHub App 回传出站（JWT → Installation Token → Commit Status）。
 *
 * 架构：**Mock GitHub API 服务器**（http.createServer，零真实外网）模拟
 * `POST /app/installations/{id}/access_tokens`（JWT 换 Token）与
 * `POST /repos/{o}/{r}/statuses/{sha}`（回传）；`GITHUB_API_BASE_URL` 指向它。
 *
 * 覆盖：
 *  1. JWT 签发正确（RS256 三段式；iss = appId；exp-iat ∈ [480, 600]；公钥验签通过）；
 *  2. Token 换取成功 + 回传 Commit Status（state 映射 FAIL → failure，含 target_url / context）；
 *  3. Token 缓存命中（第二个 run 回传时 access_tokens 端点不再被调用）；
 *  4. GitHub 500 → outbound_dispatch_logs 落 FAILED 行（channel_kind='github'）
 *     且**不阻塞拉取响应、不改变本地 run 状态**（浮空 Promise 纪律：await 后响应）；
 *  5. 无 delivery 关联的 run 拉取 → 不出站（零 GitHub 调用）。
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CallbackTokenResponse, GithubIntegration } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld, type CompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

import * as gatesRoute from '../app/api/gates/route.js';
import * as tokenRoute from '../app/api/gates/[gateId]/callback-token/route.js';
import * as resultsRoute from '../app/api/gates/results/[runId]/route.js';
import * as integrationRoute from '../app/api/integrations/github/route.js';
import { resetGithubTokenCacheForTests } from '../lib/github/app-auth.js';

const DB_URL = process.env['DATABASE_URL'];
const SECRET = 'sim-webhook-secret-0f1b';
const APP_ID = '123456';
const INSTALLATION_ID = '987654';
const REPO = 'o/r';
const HEAD_SHA = 'abc123def456abc1';

/** 每个测试进程生成一对真实 RSA 密钥（RS256 签名 / 公钥验签都需要）。 */
const { privateKeyPem, publicKeyPem } = (() => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
})();

interface TokenRequestRecord {
  readonly authorization: string;
  readonly jwtClaims: { iss: string; iat: number; exp: number } | null;
  readonly jwtSignatureValid: boolean;
}

interface StatusRequestRecord {
  readonly authorization: string;
  readonly sha: string;
  readonly body: { state: string; target_url: string; description: string; context: string };
}

let tokenRequests: TokenRequestRecord[] = [];
let statusRequests: StatusRequestRecord[] = [];
let statusFailMode = false;

/** Mock GitHub API 服务器（零真实外网）。 */
let ghApi: http.Server;
let ghApiUrl = '';

function decodeJwtSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function jwtSignatureValid(signed: string, publicKeyPem: string): boolean {
  const [h, p, s] = signed.split('.');
  if (h === undefined || p === undefined || s === undefined) return false;
  const pub = crypto.createPublicKey(publicKeyPem);
  return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'));
}

beforeAll(async () => {
  process.env['PROVIDER_KEY_SECRET'] = process.env['PROVIDER_KEY_SECRET'] ?? 'sim-master-secret-for-tests';
  process.env['GITHUB_API_BASE_URL'] = ''; // 占位，beforeEach 里指向 mock（端口动态）
  ghApi = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers['authorization'] ?? '';
      if (req.url?.startsWith('/app/installations/') && req.method === 'POST') {
        const authorization = String(auth);
        const jwt = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        const payload = jwt.split('.').length === 3 ? decodeJwtSegment(jwt.split('.')[1]!) : null;
        tokenRequests = [
          ...tokenRequests,
          {
            authorization,
            jwtClaims:
              payload !== null && typeof payload.iss === 'string' && typeof payload.iat === 'number' && typeof payload.exp === 'number'
                ? { iss: payload.iss, iat: payload.iat, exp: payload.exp }
                : null,
            jwtSignatureValid: jwt.split('.').length === 3 && jwtSignatureValid(jwt, publicKeyPem),
          },
        ];
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ token: `ghs-mock-${String(tokenRequests.length)}`, expires_at: '2026-12-31T00:00:00Z' }));
        return;
      }
      if (req.url?.startsWith('/repos/o/r/statuses/') && req.method === 'POST') {
        const sha = req.url.split('/statuses/')[1] ?? '';
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw) as StatusRequestRecord['body'];
        statusRequests = [...statusRequests, { authorization: String(auth), sha, body }];
        if (statusFailMode) {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: 'mock github internal error' }));
          return;
        }
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 1, state: body.state }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => ghApi.listen(0, '127.0.0.1', () => resolve()));
  ghApiUrl = `http://127.0.0.1:${String((ghApi.address() as AddressInfo).port)}`;
  process.env['GITHUB_API_BASE_URL'] = ghApiUrl;
});

function req(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeEach(async () => {
  tokenRequests = [];
  statusRequests = [];
  statusFailMode = false;
  resetGithubTokenCacheForTests();
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  ghApi.close();
  await closeDb();
  await restoreSeed(databaseUrl());
});

async function createIntegration(): Promise<string> {
  const res = await integrationRoute.POST(
    req('/api/integrations/github', {
      method: 'POST',
      body: { name: '回传集成', appId: APP_ID, installationId: INSTALLATION_ID, privateKey: privateKeyPem, webhookSecret: SECRET, repos: [{ owner: 'o', repo: 'r' }] },
    }),
  );
  expect(res.status).toBe(201);
  const view = GithubIntegration.parse(await res.json());
  expect(view.hasPrivateKey).toBe(true); // 写入形状进、读取形状只有布尔位（契约非对称锚点）
  return view.id;
}

async function createGateFor(w: CompareWorld, name: string, threshold: number): Promise<string> {
  await gatesRoute.POST(
    req('/api/gates', {
      method: 'POST',
      body: { name, datasetId: w.datasetId, condition: { metric: 'score_overall', op: '<', value: threshold }, action: 'BLOCK' },
    }),
  );
  return (
    await getPool().query<{ id: string }>('SELECT id FROM regression_gates WHERE dataset_id = $1 AND name = $2', [w.datasetId, name])
  ).rows[0]!.id;
}

async function issueTokenAndPull(gateId: string, runId: string): Promise<number> {
  const token = CallbackTokenResponse.parse(
    await (await tokenRoute.POST(req('/api/gates', { method: 'POST' }), { params: Promise.resolve({ gateId }) })).json(),
  ).token;
  const res = await resultsRoute.GET(
    req(`/api/gates/results/${runId}`, { headers: { 'x-callback-token': token } }),
    { params: Promise.resolve({ runId }) },
  );
  return res.status;
}

async function seedDelivery(integrationId: string, runId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO webhook_deliveries
       (delivery_id, integration_id, event, signature_verified, processed_status, run_id, payload_summary)
     VALUES ('d-' || $1, $2, 'pull_request', true, 'TRIGGERED', $1::uuid,
             jsonb_build_object('repo_full_name', $3::text, 'head_sha', $4::text, 'pr_number', 1))`,
    [runId, integrationId, REPO, HEAD_SHA],
  );
}

// ---------------------------------------------------------------------------

describe('M5 Batch 3 · GitHub App 回传出站', () => {
  let w: CompareWorld;
  let integrationId: string;
  let gateBlockId: string;

  beforeEach(async () => {
    w = await buildCompareWorld({ name: 'outbound', baseline: { name: 'b', evaluators: [], cases: [] }, current: { name: 'c', evaluators: [], cases: [] } });
    integrationId = await createIntegration();
    gateBlockId = await createGateFor(w, 'CI-SIM · 阻断线', 0.85);
  });

  it('全链路：JWT 换 Token → Status 回传 → 留痕 SUCCESS', async () => {
    await seedDelivery(integrationId, w.currentRunId);
    expect(await issueTokenAndPull(gateBlockId, w.currentRunId)).toBe(200);

    // GitHub API 侧：access_tokens 恰一次、JWT 形状与签名正确
    expect(tokenRequests).toHaveLength(1);
    const jwtRec = tokenRequests[0]!;
    expect(jwtRec.authorization.startsWith('Bearer ')).toBe(true);
    expect(jwtRec.jwtClaims?.iss).toBe(APP_ID);
    const span = (jwtRec.jwtClaims?.exp ?? 0) - (jwtRec.jwtClaims?.iat ?? 0);
    expect(span >= 480 && span <= 600).toBe(true);
    expect(jwtRec.jwtSignatureValid).toBe(true);

    // Status：Bearer 为 Installation Token（ghs- 前缀），state 映射 FAIL → failure
    expect(statusRequests).toHaveLength(1);
    const st = statusRequests[0]!;
    expect(st.authorization).toBe('Bearer ghs-mock-1');
    expect(st.sha).toBe(HEAD_SHA);
    expect(st.body.state).toBe('failure');
    expect(st.body.context.startsWith('eval-platform')).toBe(true);
    expect(st.body.target_url).toContain(w.currentRunId);

    // 留痕：channel_kind='github'、SUCCESS
    const log = await getPool().query<{ channel_kind: string; status: string; channel_url: string }>(
      `SELECT channel_kind, status, channel_url FROM outbound_dispatch_logs WHERE eval_run_id = $1`,
      [w.currentRunId],
    );
    expect(log.rows[0]!).toMatchObject({ channel_kind: 'github', status: 'SUCCESS' });
    expect(log.rows[0]!.channel_url).toContain('/repos/o/r/statuses/');
  }, 60_000);

  it('Token 缓存命中：第二个 run 回传不再请求 access_tokens', async () => {
    await seedDelivery(integrationId, w.currentRunId);
    await seedDelivery(integrationId, w.baselineRunId);
    expect(await issueTokenAndPull(gateBlockId, w.currentRunId)).toBe(200);
    expect(await issueTokenAndPull(gateBlockId, w.baselineRunId)).toBe(200);
    expect(statusRequests).toHaveLength(2);
    expect(tokenRequests).toHaveLength(1); // 缓存命中：第二次不换 Token
    expect(statusRequests.every((s) => s.authorization === 'Bearer ghs-mock-1')).toBe(true);
  }, 60_000);

  it('GitHub 500 → 留痕 FAILED（含原因）且不阻塞响应、不改 run 状态', async () => {
    statusFailMode = true;
    await seedDelivery(integrationId, w.currentRunId);
    expect(await issueTokenAndPull(gateBlockId, w.currentRunId)).toBe(200); // 拉取响应不受影响
    const log = await getPool().query<{ status: string; error_message: string | null }>(
      `SELECT status, error_message FROM outbound_dispatch_logs WHERE eval_run_id = $1`,
      [w.currentRunId],
    );
    expect(log.rows[0]!).toMatchObject({ status: 'FAILED', error_message: expect.stringContaining('500') });
    const run = await getPool().query<{ status: string }>(`SELECT status FROM eval_runs WHERE id = $1`, [w.currentRunId]);
    expect(run.rows[0]!.status).toBe('COMPLETED'); // 本地 run 状态不被 GitHub 故障污染
  }, 60_000);

  it('无 delivery 关联的 run 拉取 → 零 GitHub 调用', async () => {
    expect(await issueTokenAndPull(gateBlockId, w.baselineRunId)).toBe(200);
    expect(tokenRequests).toHaveLength(0);
    expect(statusRequests).toHaveLength(0);
  }, 60_000);
});
