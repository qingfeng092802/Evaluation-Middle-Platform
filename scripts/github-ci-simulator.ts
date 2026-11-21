/**
 * M5 Batch 5 · GitHub CI 全链路模拟脚本
 *
 * 真实 Route Handler + 真实 dev 库 + 真实 HTTP + Mock GitHub API（零真实外网）。
 * 全闭环：webhook 验签 → delivery → 规则匹配 → CI 拉取 → 求值 → Status 回传。
 *
 * 前置：dev:all 常驻（dev 库有 COMPLETED run 可用）
 * 用法：npx tsx scripts/github-ci-simulator.ts
 */
process.env['PROVIDER_KEY_SECRET'] = 'sim-master-secret-for-tests';

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';

import * as integrationRoute from '../app/api/integrations/github/route.js';
import * as webhookRoute from '../app/api/integrations/github/webhook/route.js';
import * as gatesRoute from '../app/api/gates/route.js';
import * as tokenRoute from '../app/api/gates/[gateId]/callback-token/route.js';
import * as resultsRoute from '../app/api/gates/results/[runId]/route.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { restoreSeed } from '../tests/support/fixtures.js';

const WEBHOOK_SECRET = 'ci-sim-webhook-secret';
const APP_ID = '999888';
const INSTALLATION_ID = '777666';
const REPO = 'qingfeng092802/eval-demo';
const HEAD_SHA = 'abcd1234efgh5678';

// --- Mock GitHub API ---
const statusPosts: Array<{ sha: string; auth: string; body: Record<string, unknown> }> = [];
let tokenExchanges = 0;
let ghApiPort = 0;
let ghApi: http.Server | null = null;

function startMockGithubApi(): Promise<void> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const auth = String(req.headers['authorization'] ?? '');
        if (req.url?.includes('/app/installations/') && req.method === 'POST') {
          tokenExchanges++;
          res.statusCode = 201;
          res.end(JSON.stringify({ token: `ghs-mock-${String(tokenExchanges)}`, expires_at: '2027-01-01T00:00:00Z' }));
          return;
        }
        if (req.url?.includes('/statuses/') && req.method === 'POST') {
          const sha = req.url.split('/statuses/')[1] ?? '';
          statusPosts.push({ sha, auth, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
          res.statusCode = 201;
          res.end(JSON.stringify({ id: statusPosts.length }));
          return;
        }
        res.statusCode = 404; res.end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      ghApiPort = (srv.address() as AddressInfo).port;
      process.env['GITHUB_API_BASE_URL'] = `http://127.0.0.1:${String(ghApiPort)}`;
      resolve();
    });
    ghApi = srv;
  });
}

// --- 平台挂载服务器 ---
let platformUrl = '';

function startPlatform(): Promise<void> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const hasBody = req.method === 'POST' || req.method === 'PATCH';
        const nextReq = new NextRequest(`http://127.0.0.1${req.url}`, {
          method: req.method ?? 'GET', headers: req.headers as Record<string, string>,
          ...(hasBody ? { body: raw } : {}),
        });
        void (async () => {
          let r: Response;
          if (req.url === '/api/integrations/github' && req.method === 'POST') r = await integrationRoute.POST(nextReq);
          else if (req.url === '/api/integrations/github/webhook' && req.method === 'POST') r = await webhookRoute.POST(nextReq);
          else if (req.url === '/api/gates' && req.method === 'POST') r = await gatesRoute.POST(nextReq);
          else if (req.url?.includes('/callback-token') && req.method === 'POST') r = await tokenRoute.POST(nextReq, { params: Promise.resolve({ gateId: req.url.split('/')[4] ?? '' }) });
          else if (req.url?.includes('/results/') && req.method === 'GET') {
            const runId = req.url.split('/results/')[1]?.split('?')[0] ?? '';
            r = await resultsRoute.GET(new NextRequest(nextReq.url, { headers: nextReq.headers }), { params: Promise.resolve({ runId }) });
          } else { res.statusCode = 404; res.end('{"error":"not mounted"}'); return; }
          res.statusCode = r.status; res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json'); res.end(await r.text());
        })().catch((e: unknown) => { res.statusCode = 500; res.end(JSON.stringify({ message: String(e) })); });
      });
    });
    srv.listen(0, '127.0.0.1', () => { platformUrl = `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`; resolve(); });
  });
}

// --- 工具 ---
let passed = 0; let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.log(`  ✗ ${msg}`); process.exitCode = 1; }
}
function section(t: string): void { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`); }
function sign(s: string, raw: string): string { return `sha256=${crypto.createHmac('sha256', s).update(raw).digest('hex')}`; }
async function postJson(url: string, body: unknown, hdr?: Record<string, string>): Promise<{ status: number; body: string }> {
  const raw = JSON.stringify(body);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr }, body: raw });
  return { status: res.status, body: await res.text() };
}
async function get(url: string, hdr?: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers: hdr ?? {} });
  return { status: res.status, body: await res.text() };
}

// --- 主流程 ---
async function main(): Promise<void> {
  section('§0 · 环境启动');
  await startMockGithubApi();
  await startPlatform();
  console.log(`  ✓ Mock GitHub API: :${String(ghApiPort)}`);
  console.log(`  ✓ 平台挂载服务器: ${platformUrl}`);
  const runs = await getPool().query<{ id: string; status: string; dataset_id: string }>(
    `SELECT r.id, r.status, dv.dataset_id FROM eval_runs r JOIN dataset_versions dv ON dv.id = r.dataset_version_id WHERE r.status = 'COMPLETED' LIMIT 1`
  );
  if (runs.rows.length === 0) { console.log('  ✗ dev 库无 COMPLETED run——请先跑 e2e-demo'); process.exitCode = 1; return; }
  const runId = runs.rows[0]!.id;
  const datasetId = runs.rows[0]!.dataset_id;
  console.log(`  ✓ dev 库 COMPLETED run: ${runId.slice(0, 8)}…`);

  section('§1 · 造数：集成 + 门禁 + 触发规则 + delivery→run 链路');
  const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const createRes = await postJson(`${platformUrl}/api/integrations/github`, { name: 'E2E 集成', appId: APP_ID, installationId: INSTALLATION_ID, privateKey: pem, webhookSecret: WEBHOOK_SECRET, repos: [{ owner: 'o', repo: 'r' }] });
  ok(createRes.status === 201, '集成创建 → 201');
  const integrationId = (JSON.parse(createRes.body) as { id: string }).id;

  const gateRes = await postJson(`${platformUrl}/api/gates`, { name: 'E2E 阻断线', datasetId, condition: { metric: 'score_overall', op: '<', value: 0.85 }, action: 'BLOCK' });
  ok(gateRes.status === 201, '门禁规则 → 201');
  const gateId = (JSON.parse(gateRes.body) as { id: string }).id;

  const ruleRes = await postJson(`${platformUrl}/api/pr-trigger-rules`, { integrationId, repoFullName: REPO, targetBranch: 'main', datasetId });
  ok(ruleRes.status === 201, '触发规则 → 201');

  // delivery→run 链路（TRIGGERED 指向 COMPLETED run）
  await getPool().query(
    `INSERT INTO webhook_deliveries (delivery_id, integration_id, event, signature_verified, processed_status, run_id, payload_summary)
     VALUES ('e2e-prior', $1, 'pull_request', true, 'TRIGGERED', $2::uuid, jsonb_build_object('repo_full_name',$3::text,'pr_number',1,'head_sha',$4::text,'action','opened'))`,
    [integrationId, runId, REPO, HEAD_SHA],
  );
  console.log('  ✓ delivery→run 链路已建立');

  const tokenRes = await postJson(`${platformUrl}/api/gates/${gateId}/callback-token`, {});
  const callbackToken = (JSON.parse(tokenRes.body) as { token: string }).token;

  section('§2 · Webhook (opened) → 验签 + delivery + 规则匹配');
  const whPayload = { action: 'opened', number: 1, repository: { full_name: REPO }, pull_request: { head: { sha: HEAD_SHA, ref: 'f' }, base: { ref: 'main' }, labels: [], html_url: `https://github.com/${REPO}/pull/1` } };
  const whRaw = JSON.stringify(whPayload);
  const whPost = await postJson(`${platformUrl}/api/integrations/github/webhook`, whPayload, { 'x-hub-signature-256': sign(WEBHOOK_SECRET, whRaw), 'x-github-event': 'pull_request', 'x-github-delivery': 'e2e-wh-1' });
  ok(whPost.status === 200, `Webhook → ${String(whPost.status)}`);
  const whBody = JSON.parse(whPost.body) as Record<string, unknown>;
  ok(whBody.status === 'TRIGGERED', `状态 = ${String(whBody.status)}`);
  const dRows = await getPool().query<{ processed_status: string }>('SELECT processed_status FROM webhook_deliveries WHERE delivery_id = $1', ['e2e-wh-1']);
  ok(dRows.rows[0] !== undefined && dRows.rows[0]!.processed_status === 'TRIGGERED', 'delivery TRIGGERED 已落账');

  section('§3 · CI 拉取门禁结果 → 求值 → Commit Status 回传');
  const pull = await get(`${platformUrl}/api/gates/results/${runId}`, { 'x-callback-token': callbackToken });
  const pullData = JSON.parse(pull.body) as { gateResult?: { overall?: string } };
  ok(pull.status === 200, `拉取 → ${String(pull.status)}`);
  ok(pullData.gateResult?.overall !== undefined, `overall = ${String(pullData.gateResult?.overall)}`);
  await new Promise((r) => setTimeout(r, 500));
  ok(statusPosts.length >= 1, `Mock GitHub 收到 ${String(statusPosts.length)} 次 Status POST`);
  if (statusPosts.length > 0) {
    const sp = statusPosts[0]!;
    ok(sp.auth.startsWith('Bearer ghs-mock-'), 'Authorization = Bearer ghs-mock-…');
    ok(sp.body.state === 'failure' || sp.body.state === 'success', `state = ${String(sp.body.state)}`);
    const tu = String(sp.body.target_url ?? '');
    ok(tu.includes(runId), 'target_url 含 runId');
    console.log(`  → Status: ${JSON.stringify(sp.body)}`);
  }

  section('§4 · 验签失败 → 401 零落账');
  const badSig = 'sha256=' + '0'.repeat(64);
  const bad = await postJson(`${platformUrl}/api/integrations/github/webhook`, whPayload, { 'x-hub-signature-256': badSig, 'x-github-event': 'pull_request', 'x-github-delivery': 'e2e-bad' });
  ok(bad.status === 401, `伪造签名 → ${String(bad.status)}`);
  const badRows = await getPool().query<{ id: string }>('SELECT id FROM webhook_deliveries WHERE delivery_id = $1', ['e2e-bad']);
  ok(badRows.rows.length === 0, '验签失败零落账');

  section('§5 · Synchronize → 协作式取消请求');
  const runningRun = await getPool().query<{ id: string }>(
    `INSERT INTO eval_runs (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility, runner_version, created_by, total_cases, status)
     SELECT 'ci-sim-running', dataset_version_id, target_version_id, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', 0, 'RUNNING' FROM eval_runs WHERE id = $1 RETURNING id`,
    [runId],
  );
  const oldRunId = runningRun.rows[0]!.id;
  await getPool().query(
    `INSERT INTO webhook_deliveries (delivery_id, integration_id, event, signature_verified, processed_status, run_id, payload_summary)
     VALUES ('e2e-prior-old', $1, 'pull_request', true, 'TRIGGERED', $2::uuid, jsonb_build_object('repo_full_name',$3::text,'pr_number',1,'head_sha','old_sha','action','opened'))`,
    [integrationId, oldRunId, REPO],
  );
  const syncPayload = { ...whPayload, action: 'synchronize', pull_request: { ...whPayload.pull_request, head: { sha: 'new_sha', ref: 'f' } } };
  const sync = await postJson(`${platformUrl}/api/integrations/github/webhook`, syncPayload, { 'x-hub-signature-256': sign(WEBHOOK_SECRET, JSON.stringify(syncPayload)), 'x-github-event': 'pull_request', 'x-github-delivery': 'e2e-sync-1' });
  ok(sync.status === 200, `synchronize → ${String(sync.status)}`);
  const cancelCheck = await getPool().query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM eval_runs WHERE id = $1', [oldRunId]);
  ok(cancelCheck.rows[0] !== undefined && cancelCheck.rows[0]!.cancel_requested === true, 'cancel_requested = true（Q3）');

  section('§6 · 安全自查（API 响应零凭据明文）');
  const detail = await get(`${platformUrl}/api/integrations/github/${integrationId}`);
  ok(!detail.body.includes(pem.slice(0, 20)), '详情响应不含 PEM 明文');
  ok(!detail.body.includes(WEBHOOK_SECRET), '详情响应不含 webhook_secret 明文');
  ok(JSON.parse(detail.body).hasPrivateKey === true, 'hasPrivateKey = true（布尔位在）');

  section('§7 · 结论');
  console.log(`  通过 ${String(passed)} / 失败 ${String(failed)}`);
  if (failed === 0) console.log('\n  [ci-sim-e2e] 全链路闭环验证通过。');
  else process.exitCode = 1;

  ghApi?.close();
  await closeDb();
  await restoreSeed('postgres://eval:eval_local_dev_only@127.0.0.1:5433/eval_platform');
  console.log('  [cleanup] Mock GitHub API 已关闭、测试库已还原。');
}

main().catch((e: unknown) => { console.error('[ci-sim-e2e] 致命错误：', e); process.exitCode = 1; });
