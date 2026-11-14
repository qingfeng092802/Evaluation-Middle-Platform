/**
 * 常驻 worker 态下的两件事（Batch 3 · 交付物 2 的 worker 半边 + 交付物 3 的计费切片）。
 *
 * ## 为什么必须是真的 worker 进程 + 真的计数网关
 *
 * 1. **`NOTIFY` 有没有发出来。** 忘了发的话，SSE 流只剩心跳：页面每 15s
 *    重读一次库，进度条一跳一跳地走 —— 看起来「慢」，不像故障。
 *    在本进程里 `pg_notify` 不能证明 worker 的写入路径发了它，所以订阅方是
 *    测试自己的独立连接，写入方是**另起的 `worker/index.ts` 进程**。
 *
 * 2. **断线重连会不会导致重复计费。** 「零重复计费切片」唯一能被观测到的位置是
 *    网关：同一条 Case 的输入若被厂商收到两次，账单就多一次。
 *    行级幂等（`ON CONFLICT DO NOTHING`）挡得住重复**行**，挡不住重复**调用** ——
 *    而重复调用正是重复计费。所以网关按「输入的 query 文本」分别计数，
 *    每条必须恰好 1 次。
 *
 * 断线重连按 `technical-solution.md` §3.5 [6] 走：断开 → `GET /api/runs/:id`
 * 拉全量快照 → 带 `Last-Event-ID` 重新订阅。`snapshot_only`：不补发历史事件。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSseDataLine } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { closeDb } from '../db/schema/index.js';
import { restoreSeed } from './support/fixtures.js';
import * as streamRoute from '../app/api/runs/[runId]/stream/route.js';
import * as runRoute from '../app/api/runs/[runId]/route.js';

const SRC_ROOT = process.cwd();
const DB_URL = databaseUrl();
const BASE = 'http://localhost:3000';
const GATEWAY_PORT = 8797;

// ---------------------------------------------------------------------------
// 计数网关：按 query 文本分别计数（重复调用 = 重复计费）
// ---------------------------------------------------------------------------

interface CountingGateway {
  readonly perQuery: () => ReadonlyMap<string, number>;
  readonly total: () => number;
  /** 单请求耗时（毫秒）。计费切片要「跑得够慢」才来得及在中途断线。 */
  readonly setDelay: (ms: number) => void;
  readonly close: () => Promise<void>;
}

function startCountingGateway(port: number, initialDelayMs: number): Promise<CountingGateway> {
  const hits = new Map<string, number>();
  let total = 0;
  let delayMs = initialDelayMs;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || (req.url ?? '') !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const text = lastUser?.content ?? '';
      hits.set(text, (hits.get(text) ?? 0) + 1);
      total += 1;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `[notify-gw] ${text}` } }],
            usage: { prompt_tokens: 6, completion_tokens: 4 },
          }),
        );
      }, delayMs);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        perQuery: () => hits,
        total: () => total,
        setDelay: (ms) => {
          delayMs = ms;
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
// 夹具
// ---------------------------------------------------------------------------

let admin: Client;

async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await admin.query<T>(sql, params);
  const row = res.rows[0];
  if (!row) throw new Error(`期望一行：${sql}`);
  return row;
}

interface SeededRun {
  readonly runId: string;
  readonly queries: readonly string[];
}

/**
 * 造一个 N 条 Case 的 PENDING run。
 *
 * `run_evaluators` 是必须的：没有算子快照的 run 会被 worker 直接判终态，
 * 一条 Case 都不会跑 —— 那样网关调用次数恒为 0，测试「通过得毫无意义」。
 */
/** 执行一条 `... RETURNING id` 并取出 id。 */
async function idOf(sql: string, params: unknown[] = []): Promise<string> {
  return (await q<{ id: string }>(sql, params)).id;
}

async function seedRun(tag: string, caseCount: number, concurrency: number): Promise<SeededRun> {
  const datasetId = await idOf(`INSERT INTO datasets (name, owner_id) VALUES ($1,'t') RETURNING id`, [
    `ds-notify-${tag}`,
  ]);
  const versionId = await idOf(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1,1,$2,$3,'import','t') RETURNING id`,
    [datasetId, caseCount, `sha256:notify-${tag}`],
  );

  const queries: string[] = [];
  for (let i = 0; i < caseCount; i += 1) {
    const text = `[notify-${tag}] case-${String(i)}`;
    queries.push(text);
    await idOf(
      `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input, metadata)
       VALUES ($1,$2,$3,$4::jsonb,'{}'::jsonb) RETURNING id`,
      [versionId, `c-${tag}-${String(i)}`, i, JSON.stringify({ query: text })],
    );
  }

  const providerId = await idOf(
    `INSERT INTO model_providers
       (name, kind, base_url, api_key_ciphertext, api_key_masked, max_concurrency, is_active)
     VALUES ($1,'openai_compatible',$2,'plain-fixture','fixture-••••mask',2,true) RETURNING id`,
    [`mp-notify-${tag}`, `http://127.0.0.1:${String(GATEWAY_PORT)}`],
  );
  const targetId = await idOf(
    `INSERT INTO targets (name, kind, current_version_no, owner_id)
     VALUES ($1,'t1_prompt',1,'t') RETURNING id`,
    [`tg-notify-${tag}`],
  );
  const targetVersionId = await idOf(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1,1,'t1_prompt',$2,'notify-model','{{input.query}}',0,32,'t') RETURNING id`,
    [targetId, providerId],
  );
  // `config_snapshot` / `reproducibility` 必须是**完整契约形状**，不能塞 `'{}'`：
  // `GET /api/runs/:id` 在出站前会用 `EvalRunDetail.parse()` 校验，形状不对直接 400。
  // 断线重连的第一步就是打这个接口 —— 夹具偷懒的话，测的就不是重连，而是契约校验。
  const configSnapshot = {
    datasetVersionId: versionId,
    datasetContentHash: `sha256:notify-${tag}`,
    targetVersionId,
    targetKind: 't1_prompt',
    evaluators: [
      {
        config: {
          key: 'regex',
          pattern: '^\\[notify-gw\\]',
          caseSensitive: true,
          shouldMatch: true,
        },
        weight: 1,
      },
    ],
    priceSnapshot: [],
  };
  const reproducibility = {
    temperature: 0,
    topP: null,
    maxTokens: 32,
    seed: null,
    runnerVersion: 'test',
    modelVersionString: null,
    promptTemplateHash: `sha256:notify-${tag}-prompt`,
    cachePolicy: 'none',
  };
  const runId = await idOf(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'test','t',$7,'PENDING') RETURNING id`,
    [
      `run-notify-${tag}`,
      versionId,
      targetVersionId,
      concurrency,
      JSON.stringify(configSnapshot),
      JSON.stringify(reproducibility),
      caseCount,
    ],
  );
  await idOf(
    `INSERT INTO run_evaluators
       (eval_run_id, evaluator_key, evaluator_version, kind, config, weight, pass_threshold, order_index)
     VALUES ($1, 'regex', 1, 'rule',
             '{"key":"regex","pattern":"^\\\\[notify-gw\\\\]","caseSensitive":true,"shouldMatch":true}'::jsonb,
             1, NULL, 0) RETURNING id`,
    [runId],
  );
  return { runId, queries };
}

async function runStatus(runId: string): Promise<string> {
  const res = await admin.query<{ status: string }>(`SELECT status FROM eval_runs WHERE id = $1`, [runId]);
  return res.rows[0]?.status ?? 'MISSING';
}

async function waitFor(label: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error(`等超时：${label}（${String(ms)}ms）`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// SSE 线上读帧（与 route spec 同形，只保留本文件需要的部分）
// ---------------------------------------------------------------------------

interface WireFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string;
}

function parseFrame(raw: string): WireFrame {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { id, event, data: dataLines.join('\n') };
}

class SseReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  /**
   * **正在等待的那次 `read()`**。
   *
   * 不能每轮都新起一个 `read()` 再和超时赛跑 —— 超时赢了之后那个 `read()`
   * 仍然挂着，下一块数据会交给它（没人 await），**帧就这样被静默吞掉**。
   * 症状是「run 明明跑完了，流却一帧没吐」，看起来像服务端没发事件。
   * 所以：未消费的读操作留着复用，只有真正取到结果才清空。
   */
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private readOnce(): Promise<ReadableStreamReadResult<Uint8Array>> {
    this.pending ??= this.reader.read();
    return this.pending;
  }

  async next(ms = 5000): Promise<WireFrame | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const idx = this.buffer.indexOf('\n\n');
      if (idx >= 0) {
        const raw = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        if (raw.trim() === '') continue;
        return parseFrame(raw);
      }
      const res = await Promise.race([
        this.readOnce(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 100)),
      ]);
      if (res === 'timeout') continue;
      this.pending = null;
      if (res.done) return null;
      this.buffer += this.decoder.decode(res.value, { stream: true });
    }
    return null;
  }

  async until(pred: (f: WireFrame) => boolean, ms = 5000): Promise<WireFrame[]> {
    const out: WireFrame[] = [];
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const f = await this.next(Math.max(1, deadline - Date.now()));
      if (f === null) break;
      out.push(f);
      if (pred(f)) break;
    }
    return out;
  }

  /** 客户端断开：触发 route 的 cancel ⇒ 生成器 `finally` 关掉 `LISTEN`。 */
  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

async function openStream(runId: string, lastEventId?: string): Promise<SseReader> {
  const req = new NextRequest(`${BASE}/api/runs/${runId}/stream`, {
    headers: lastEventId === undefined ? {} : { 'last-event-id': lastEventId },
  });
  const res = await streamRoute.GET(req, { params: Promise.resolve({ runId }) });
  if (res.body === null) throw new Error('事件流没有响应体');
  return new SseReader(res.body.getReader());
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

let gateway: CountingGateway | null = null;
const procs: WorkerProc[] = [];

beforeAll(async () => {
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
  await resetDatabase(DB_URL);
  gateway = await startCountingGateway(GATEWAY_PORT, 150);
}, 60_000);

afterAll(async () => {
  for (const p of procs) await killProc(p);
  if (gateway) await gateway.close();
  await admin.end();
  await closeDb().catch(() => undefined);
  await restoreSeed(DB_URL).catch(() => undefined);
}, 60_000);

describe('worker 写库后 NOTIFY run_progress', () => {
  it(
    '每落一条 Case 至少通知一次，且通知的 payload 就是 runId',
    async () => {
      const seeded = await seedRun('ntf', 3, 2);
      const before = gateway?.total() ?? 0;

      // 订阅方是**本进程的独立连接**：证明通知真的从 worker 进程发出来了
      const listener = new Client({ connectionString: DB_URL });
      await listener.connect();
      const received: string[] = [];
      listener.on('notification', (msg) => {
        if (msg.channel === 'run_progress' && msg.payload !== undefined) received.push(msg.payload);
      });
      await listener.query('LISTEN run_progress');

      const w = spawnWorker({
        WORKER_STALE_AFTER: '2 minutes',
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_CONCURRENCY: '1',
      });
      procs.push(w);

      await waitFor(
        'run COMPLETED',
        async () => (await runStatus(seeded.runId)) === 'COMPLETED',
        60_000,
      ).catch((err: unknown) => {
        console.error('[N-01] worker 输出：\n' + w.lines.join('\n'));
        throw err;
      });
      // 通知在事务提交后异步投递，给最后一个 NOTIFY 一点到达时间
      await new Promise((r) => setTimeout(r, 300));
      await listener.end();

      const mine = received.filter((p) => p === seeded.runId);
      console.log(
        `[N-01] notifyCount=${String(mine.length)} cases=${String(seeded.queries.length)} ` +
          `gatewayCalls=${String((gateway?.total() ?? 0) - before)}`,
      );

      // 3 条 Case ⇒ 至少 3 次（实现在落行与刷计数两处各发一次也可以）
      expect(mine.length).toBeGreaterThanOrEqual(seeded.queries.length);
      // 每条通知携带的必须是 runId —— 客户端靠它筛自己的流
      expect(mine.every((p) => p.length > 0)).toBe(true);

      await killProc(w);
    },
    90_000,
  );
});

describe('零重复计费切片 · SSE 断线重连', () => {
  it(
    '断线 → 拉快照 → 带 Last-Event-ID 重连：每条 Case 的网关调用恰好 1 次，进度不倒退',
    async () => {
      const CASE_COUNT = 4;
      const seeded = await seedRun('bill', CASE_COUNT, 2);
      const beforeTotal = gateway?.total() ?? 0;
      // 放慢网关：断线必须发生在 **run 还在跑的时候**，
      // 否则「重连后没有新增网关调用」只是因为跑完了，而不是因为没重复计费。
      gateway?.setDelay(800);

      // ---- 先连上，再让 worker 领取 ----
      //
      // 顺序很重要：worker 每 800ms 才跑完一条 Case，4 条同步跑完只要 1s 多。
      // 若「先起 worker 再连」，流连上时快照已经是 COMPLETED —— 终态没有在途调用，
      // 断线切片就退化成「连了一个已结束的 run」，测不出任何东西。
      const first = await openStream(seeded.runId);
      const snapshot1 = await first.next(8000);
      expect(snapshot1?.event).toBe('snapshot');

      const w = spawnWorker({
        WORKER_STALE_AFTER: '2 minutes',
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_CONCURRENCY: '1',
      });
      procs.push(w);

      const frames1 = await first.until((f) => f.event === 'case', 60_000);
      const case1 = frames1.find((f) => f.event === 'case');
      if (case1 === undefined) {
        const s = await runStatus(seeded.runId);
        throw new Error(
          `第一段连接没收到 case 事件（run=${s}，帧=${
            frames1.map((f) => f.event).join(',') || '无'
          }）`,
        );
      }
      const parsed1 = parseSseDataLine(`data: ${case1.data}`);
      if (parsed1?.type !== 'case') throw new Error('case 帧解析失败');
      const seenBeforeDrop = parsed1.completedCount;
      const lastId = case1.id ?? `${seeded.runId}:1`;

      // ---- 断线（模拟标签页切走 / 网络抖动）----
      // `cancel()` 会走到 Route Handler 的 `ReadableStream.cancel()` ⇒ `generator.return()`，
      // 那条 `LISTEN` 连接立即释放 —— 这正是真实断线的行为，不是「假装断开了」。
      await first.cancel();

      // ---- §3.5 [6] 步骤 2：先拉全量快照（快照即真相）----
      const snapRes = await runRoute.GET(
        new NextRequest(`${BASE}/api/runs/${seeded.runId}`),
        { params: Promise.resolve({ runId: seeded.runId }) },
      );
      const snapBody = await snapRes.text();
      expect(snapRes.status, `快照接口返回 ${String(snapRes.status)}：${snapBody.slice(0, 400)}`).toBe(200);
      const snapshot = JSON.parse(snapBody) as {
        counts: { totalCases: number; succeededCases: number; failedCases: number; skippedCases: number };
      };
      const completedAtSnapshot =
        snapshot.counts.succeededCases + snapshot.counts.failedCases + snapshot.counts.skippedCases;
      // 进度不倒退：快照值不会小于断线前看到的
      expect(completedAtSnapshot).toBeGreaterThanOrEqual(seenBeforeDrop);

      // ---- 步骤 3：带 Last-Event-ID 重新订阅，丢弃 snapshot 之外的陈旧事件 ----
      const second = await openStream(seeded.runId, lastId);
      const snapshot2 = await second.next(8000);
      expect(snapshot2?.event).toBe('snapshot');
      const parsed2 = parseSseDataLine(`data: ${snapshot2!.data}`);
      if (parsed2?.type !== 'snapshot') throw new Error('snapshot 帧解析失败');
      const completedAfterReconnect =
        parsed2.counts.succeededCases + parsed2.counts.failedCases + parsed2.counts.skippedCases;
      expect(completedAfterReconnect).toBeGreaterThanOrEqual(seenBeforeDrop);

      // 读到终态
      await second.until((f) => f.event === 'status', 60_000);

      await waitFor(
        'run COMPLETED',
        async () => (await runStatus(seeded.runId)) === 'COMPLETED',
        60_000,
      ).catch((err: unknown) => {
        console.error('[B-01] worker 输出：\n' + w.lines.join('\n'));
        throw err;
      });

      // ---- 判据 1：每条 Case 的 query 只到达网关 1 次（重复计费 = 这里 > 1）----
      const hits = gateway?.perQuery() ?? new Map<string, number>();
      const mine = seeded.queries.map((text) => hits.get(text) ?? 0);
      console.log(
        `[B-01] cases=${String(CASE_COUNT)} gatewayCalls=${String((gateway?.total() ?? 0) - beforeTotal)} ` +
          `perCaseHits=[${mine.join(',')}] seenBeforeDrop=${String(seenBeforeDrop)} ` +
          `snapshot=${String(completedAtSnapshot)} afterReconnect=${String(completedAfterReconnect)}`,
      );
      expect(mine).toEqual(seeded.queries.map(() => 1));

      // ---- 判据 2：结果行 = Case 数，计数不重复累加 ----
      const rows = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM eval_case_results WHERE eval_run_id = $1`,
        [seeded.runId],
      );
      expect(Number(rows.rows[0]?.n ?? '-1')).toBe(CASE_COUNT);

      const counts = await admin.query<{ ok: string; bad: string; skipped: string; total: string }>(
        `SELECT succeeded_cases::text AS ok, failed_cases::text AS bad,
                skipped_cases::text AS skipped, total_cases::text AS total
           FROM eval_runs WHERE id = $1`,
        [seeded.runId],
      );
      const c = counts.rows[0]!;
      expect(Number(c.ok) + Number(c.bad) + Number(c.skipped)).toBe(Number(c.total));

      await killProc(w);
    },
    120_000,
  );
});
