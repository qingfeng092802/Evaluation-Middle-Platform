/**
 * 并发峰值 ≤ `model_providers.max_concurrency`（Batch 3 · 交付物 1）。
 *
 * 原文：「并发引擎：按 `model_providers.max_concurrency` 施加信号量，
 * **并发峰值不得超过上限**」。
 *
 * ## 为什么这条必须用真 worker 进程测
 *
 * 信号量写错时最典型的两种症状都是**静默的**：
 *
 *  1. **上限没接上**：`max_concurrency` 只是 PG-09 上的一个数字，
 *     执行路径照旧用 `run.concurrency`。峰值会停在 4（run 默认值），
 *     厂商那边看到的是 4 个并发 —— 比配的 2 高，但页面一切正常。
 *  2. **两个上限取了更松的那个**：`min(run, provider)` 写成 `max(...)`，
 *     或干脆只用 run 的。
 *
 * 所以判据放在**网关侧**：它自己数「同时在途的请求数」并记录峰值。
 * 这是最接近厂商实际观测位置的一层，且不受 Node 内部调度影响 —— mock 一个
 * `p-limit` 只能证明「我调用了 p-limit」，证明不了「厂商没被压垮」。
 *
 * 判据取 `min(run.concurrency, provider.max_concurrency)`：
 * run 的并发是**用户意图**（「我想快一点」），厂商的并发是**物理上限**
 * （「你最多只能这么快」）。两者冲突时物理上限优先，且必须能在读数里看出来。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { restoreSeed } from './support/fixtures.js';

const SRC_ROOT = process.cwd();
const DB_URL = databaseUrl();

const CASES_PER_RUN = 8;
const PROVIDER_MAX = 2;
const RUN_CONCURRENCY = 6;
/** 单请求耗时：足够让 8 条请求重叠，从而暴露真实峰值。 */
const REQUIRE_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// 峰值网关：自己数「同时在途」
// ---------------------------------------------------------------------------

interface PeakGateway {
  readonly close: () => Promise<void>;
  /** 历史最高同时在途请求数。 */
  readonly peak: () => number;
  readonly total: () => number;
  readonly reset: () => void;
}

function startPeakGateway(port: number): Promise<PeakGateway> {
  let inFlight = 0;
  let peak = 0;
  let total = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || (req.url ?? '') !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      inFlight += 1;
      total += 1;
      if (inFlight > peak) peak = inFlight;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const text = lastUser?.content ?? '';
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `[peak-gw] ${text}` } }],
            usage: { prompt_tokens: 8, completion_tokens: 8 },
          }),
        );
      }, REQUIRE_DELAY_MS);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        peak: () => peak,
        total: () => total,
        reset: () => {
          peak = 0;
          total = 0;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// 真 worker 进程
// ---------------------------------------------------------------------------

interface WorkerProc {
  readonly child: ChildProcess;
  readonly lines: string[];
}

function spawnWorker(env: Record<string, string>): WorkerProc {
  const child = spawn(process.execPath, ['--import', 'tsx', join(SRC_ROOT, 'worker', 'index.ts')], {
    cwd: SRC_ROOT,
    shell: false,
    env: { ...process.env, DATABASE_URL: DB_URL, ...env },
  });
  const lines: string[] = [];
  const collect = (buf: Buffer): void => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) lines.push(line);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return { child, lines };
}

async function killProc(p: WorkerProc): Promise<void> {
  if (p.child.exitCode !== null || p.child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    p.child.once('exit', () => resolve());
    p.child.kill('SIGKILL');
    setTimeout(resolve, 5000);
  });
}

// ---------------------------------------------------------------------------
// 夹具：N 条 Case 的 PENDING run + 指定并发上限的厂商
// ---------------------------------------------------------------------------

interface SeededRun {
  readonly runId: string;
  readonly caseTexts: readonly string[];
  readonly providerId: string;
}

async function seedRun(
  client: Client,
  gatewayPort: number,
  tag: string,
  caseCount: number,
  providerMax: number,
  runConcurrency: number,
): Promise<SeededRun> {
  const q = async (text: string, params: unknown[] = []): Promise<string> => {
    const res = await client.query<{ id: string }>(text, params);
    const row = res.rows[0];
    if (!row) throw new Error(`期望返回 id：${text}`);
    return row.id;
  };

  const datasetId = await q(`INSERT INTO datasets (name, owner_id) VALUES ($1, 't') RETURNING id`, [
    `ds-peak-${tag}`,
  ]);
  const versionId = await q(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1, 1, $2, $3, 'import', 't') RETURNING id`,
    [datasetId, caseCount, `sha256:${tag}`],
  );

  const caseTexts: string[] = [];
  for (let i = 0; i < caseCount; i += 1) {
    const text = `[peak-${tag}] case-${String(i)}`;
    caseTexts.push(text);
    await q(
      `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input, metadata)
       VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb) RETURNING id`,
      [versionId, `c-${tag}-${String(i)}`, i, JSON.stringify({ query: text })],
    );
  }

  const providerId = await q(
    `INSERT INTO model_providers
       (name, kind, base_url, api_key_ciphertext, api_key_masked, max_concurrency, is_active)
     VALUES ($1, 'openai_compatible', $2, 'plain-fixture', 'fixture-••••mask', $3, true)
     RETURNING id`,
    [`mp-peak-${tag}`, `http://127.0.0.1:${String(gatewayPort)}`, providerMax],
  );
  const targetId = await q(
    `INSERT INTO targets (name, kind, current_version_no, owner_id)
     VALUES ($1, 't1_prompt', 1, 't') RETURNING id`,
    [`tg-peak-${tag}`],
  );
  const targetVersionId = await q(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1, 1, 't1_prompt', $2, 'peak-model', '{{query}}', 0, 32, 't') RETURNING id`,
    [targetId, providerId],
  );
  const runId = await q(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 'test', 't', $5, 'PENDING') RETURNING id`,
    [`run-peak-${tag}`, versionId, targetVersionId, runConcurrency, caseCount],
  );

  // 没有算子快照的 run 会被 worker 直接判终态（`没有算子快照，直接聚合终态`），
  // 一条 Case 都不会跑 —— 那样峰值恒为 0，测试会「通过得毫无意义」。
  // 挂一个恒真的规则算子，让执行路径真的走起来。
  await q(
    `INSERT INTO run_evaluators
       (eval_run_id, evaluator_key, evaluator_version, kind, config, weight, pass_threshold, order_index)
     VALUES ($1, 'regex', 1, 'rule',
             '{"key":"regex","pattern":"^\\\\[peak-gw\\\\]","caseSensitive":true,"shouldMatch":true}'::jsonb,
             1, NULL, 0) RETURNING id`,
    [runId],
  );

  return { runId, caseTexts, providerId };
}

async function waitFor(label: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error(`等超时：${label}（${String(ms)}ms）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runStatus(client: Client, runId: string): Promise<string> {
  const res = await client.query<{ status: string }>(`SELECT status FROM eval_runs WHERE id = $1`, [
    runId,
  ]);
  return res.rows[0]?.status ?? 'MISSING';
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

let client: Client;
let gateway: PeakGateway | null = null;
const procs: WorkerProc[] = [];
const GATEWAY_PORT = 8795;

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
  await resetDatabase(DB_URL);
  gateway = await startPeakGateway(GATEWAY_PORT);
}, 60_000);

afterAll(async () => {
  for (const p of procs) await killProc(p);
  if (gateway) await gateway.close();
  await client.end();
  await restoreSeed(DB_URL).catch(() => undefined);
}, 60_000);

describe('并发峰值 · 真 worker 进程', () => {
  it(
    `厂商上限 ${String(PROVIDER_MAX)} < run 并发 ${String(RUN_CONCURRENCY)} ⇒ 峰值必须 ≤ ${String(PROVIDER_MAX)}`,
    async () => {
      const seeded = await seedRun(
        client,
        GATEWAY_PORT,
        'cap',
        CASES_PER_RUN,
        PROVIDER_MAX,
        RUN_CONCURRENCY,
      );
      gateway?.reset();

      const w = spawnWorker({
        WORKER_STALE_AFTER: '2 minutes',
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_CONCURRENCY: '1',
      });
      procs.push(w);

      await waitFor(
        'run COMPLETED',
        async () => (await runStatus(client, seeded.runId)) === 'COMPLETED',
        60_000,
      ).catch((err: unknown) => {
        console.error('[C-01] worker 输出：\n' + w.lines.join('\n'));
        throw err;
      });

      const peak = gateway?.peak() ?? -1;
      const total = gateway?.total() ?? -1;
      console.log(
        `[C-01] providerMax=${String(PROVIDER_MAX)} runConcurrency=${String(RUN_CONCURRENCY)} ` +
          `peak=${String(peak)} gatewayCalls=${String(total)} cases=${String(CASES_PER_RUN)}`,
      );

      expect(total).toBe(CASES_PER_RUN);
      expect(peak).toBeGreaterThan(0);
      // 核心判据：厂商侧观测到的同时在途请求数不超过它自己声明的上限
      expect(peak).toBeLessThanOrEqual(PROVIDER_MAX);

      await killProc(w);
    },
    90_000,
  );
});
