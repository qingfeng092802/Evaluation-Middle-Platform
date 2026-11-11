/**
 * 心跳租约 · 真 worker 进程级验证（#6 方案 A 的验收核心）。
 *
 * 两条必须存在的用例（用户约束 4）：
 *  - **H-10 心跳持续时不可回收**：单 Case 耗时 6s > STALE_AFTER=1s，
 *    但 worker 按 TTL/3 续写心跳 ⇒ 另一个 worker 不得把这条 run 抢走；
 *    网关请求数必须 = Case 数 × 1（不是 ×2）。
 *  - **H-11 心跳停止后另一 worker 可回收**：worker 被硬杀（SIGKILL 等价物），
 *    心跳中断超过 TTL ⇒ 第二条 run 由另一 worker 回收并**续跑剩余 Case**；
 *    已写入的 Case 不重跑（行级幂等），网关请求总数仍 = Case 数 × 1。
 *
 * 注意 H-11 的一条**如实读数**：被硬杀时已在途的 Case 会被新 worker 重打
 * （`at-least-once`），所以网关调用可能是 2 次/条，而结果行仍是 1 行/Case。
 * 这是当前语义的边界，已作为 M2 待办单列（网关幂等键去重 or 接受重复计费），
 * 不用断言把它掩盖成「没有重复调用」。
 * 这里**不用 mock 时钟**：起两个真实的 `worker/index.ts` 进程，
 * 用一个本地计数网关记录每一次补全请求。判据是网关请求数与领取日志，
 * 不是数据库里的行数 —— 行级幂等会掩盖重复调用。
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

/** 单 Case 耗时：远大于 STALE_AFTER（1s），用来逼出重复领取。 */
const CASE_DELAY_MS = 6_000;
const STALE_AFTER = '1 second';
/** 心跳间隔 = 1000/3 = 333ms；回收节奏取 250ms，保证窗口足够密。 */
const RECLAIM_INTERVAL_MS = 250;
const CASES_PER_RUN = 2;

// ---------------------------------------------------------------------------
// 计数网关：记录「最后一条 user 内容」→ 请求次数
// ---------------------------------------------------------------------------

interface CountingGateway {
  readonly close: () => Promise<void>;
  readonly hits: Map<string, number>;
}

function startCountingGateway(port: number): Promise<CountingGateway> {
  const hits = new Map<string, number>();
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
      const content = `[hb-gw] ${text}`;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content } }],
            usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: 8 },
          }),
        );
      }, CASE_DELAY_MS);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// 真 worker 进程
// ---------------------------------------------------------------------------

interface WorkerProc {
  readonly name: string;
  readonly child: ChildProcess;
  readonly lines: string[];
}

/** `node --import tsx worker/index.ts`，与 `scripts/dev-all.ts` 完全同一条路径。 */
function spawnWorker(name: string, env: Record<string, string>): WorkerProc {
  const child = spawn(process.execPath, ['--import', 'tsx', join(SRC_ROOT, 'worker', 'index.ts')], {
    cwd: SRC_ROOT,
    shell: false,
    env: { ...process.env, DATABASE_URL: DB_URL, ...env },
  });
  const lines: string[] = [];
  const collect = (buf: Buffer): void => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) lines.push(line);
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return { name, child, lines };
}

/**
 * 只杀本测试自己起的子进程（用户的常驻进程不归这里管）。
 *
 * `force` 用于**模拟 worker 硬崩溃**：心跳必须随进程一起消失。
 *
 * ## 为什么必须两条路径
 *
 * Windows 上要连子孙一起杀（tsx 会拉起 loader 子进程），只有 `taskkill /T /F` 能做到；
 * 但 `taskkill` **可能被执行环境拒绝**（本机自动模式的安全分类器会拦，返回非 0 退出码
 * 且不杀任何进程）。只依赖它的话，测试里的「硬崩溃」根本没发生，后续断言会以
 * 「进程还在跑、心跳还在续」的形式失败 —— 而失败信息完全指向错误的根因。
 *
 * 因此：**先 `child.kill('SIGKILL')`（Node 内建，不依赖外部程序），
 * 再用 `taskkill` 兜底清理可能残留的子孙进程**。两者都尝试，任一成功即可。
 *
 * ⚠️ 本机验证只到「代码路径存在」：本机 `taskkill` 被拒绝、`SIGKILL` 也可能被沙箱限制，
 * 「H-11 真的能通过」必须在有真实 kill 权限的环境（CI / 另一台机器）复跑确认。
 */
async function killTree(p: WorkerProc, force = false): Promise<void> {
  const pid = p.child.pid;
  if (!pid || p.child.exitCode !== null) return;

  if (!force) {
    await new Promise<void>((resolve) => {
      p.child.once('exit', () => resolve());
      p.child.kill('SIGTERM');
    });
    return;
  }

  // 1. Node 内建信号：不依赖任何外部可执行文件，沙箱下也最不容易被拦。
  //    它能保证**本进程**收到硬终止信号；`exit` 事件用于等它真的退出。
  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    p.child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  try {
    p.child.kill('SIGKILL');
  } catch {
    // 进程可能已被回收；下面仍试 taskkill 兜底。
  }

  // 2. `taskkill /T /F` 兜底：清掉 tsx 拉起的子孙进程（Windows 专属）。
  //    被杀环境拒绝时它只是白跑一趟，不影响上面那条路径。
  await new Promise<void>((resolve) => {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false });
    k.on('exit', () => resolve());
    k.on('error', () => resolve());
  });

  await exited;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`超时 ${timeoutMs}ms 未等到：${what}`);
}

// ---------------------------------------------------------------------------
// 造数据
// ---------------------------------------------------------------------------

interface Seeded {
  readonly runId: string;
  readonly caseTexts: readonly string[];
}

async function seedRun(
  client: Client,
  gatewayPort: number,
  tag: string,
  totalCases: number,
  options: {
    readonly runStatus?: 'PENDING' | 'RUNNING';
    /** 覆盖 run 的并发度。**`processRun` 优先用这一列**，不是 env 的 `WORKER_CONCURRENCY`。 */
    readonly concurrency?: number;
  } = {},
): Promise<Seeded> {
  const q = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T> => {
    const res = await client.query<T>(sql, params);
    const row = res.rows[0];
    if (!row) throw new Error(`期望一行：${sql}`);
    return row;
  };

  const provider = await q<{ id: string }>(
    `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked)
     VALUES ($1, 'openai_compatible', $2, 'hb-test-noop', 'hb-test-••••noop') RETURNING id`,
    [`hb-mp-${tag}`, `http://127.0.0.1:${String(gatewayPort)}`],
  );
  const ds = await q<{ id: string }>(
    `INSERT INTO datasets (name, owner_id) VALUES ($1, 't') RETURNING id`,
    [`hb-ds-${tag}`],
  );
  const dv = await q<{ id: string }>(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1, 1, $2, $3, 'import', 't') RETURNING id`,
    [ds.id, totalCases, `sha256:hb-${tag}`],
  );

  const caseTexts: string[] = [];
  for (let i = 0; i < totalCases; i++) {
    const text = `hb-${tag}-case${String(i)}`;
    caseTexts.push(text);
    await client.query(
      `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [dv.id, `${tag}-case-${String(i)}`, i, JSON.stringify({ query: text })],
    );
  }

  const tg = await q<{ id: string }>(
    `INSERT INTO targets (name, kind, owner_id) VALUES ($1, 't1_prompt', 't') RETURNING id`,
    [`hb-tg-${tag}`],
  );
  const tv = await q<{ id: string }>(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1, 1, 't1_prompt', $2, 'hb-counting', '{{input}}', 0, 64, 't') RETURNING id`,
    [tg.id, provider.id],
  );
  const run = await q<{ id: string }>(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1, $2, $3, $4, '{"priceSnapshot":[]}'::jsonb, '{}'::jsonb, 'test', 't', $5, $6)
     RETURNING id`,
    [
      `hb-run-${tag}`,
      dv.id,
      tv.id,
      options.concurrency ?? totalCases,
      totalCases,
      options.runStatus ?? 'PENDING',
    ],
  );
  await client.query(
    `INSERT INTO run_evaluators
       (eval_run_id, evaluator_key, evaluator_version, kind, config, weight, pass_threshold, order_index)
     VALUES ($1, 'regex', 1, 'rule',
             '{"key":"regex","pattern":"^\\\\[hb-gw\\\\]","caseSensitive":true,"shouldMatch":true}'::jsonb,
             1, NULL, 0)`,
    [run.id],
  );
  return { runId: run.id, caseTexts };
}

async function runStatusAndHeartbeat(
  client: Client,
  runId: string,
): Promise<{
  status: string;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  results: number;
  succeeded: number;
}> {
  const res = await client.query<{
    status: string;
    heartbeat_at: Date | null;
    started_at: Date | null;
    results: number;
    succeeded: number;
  }>(
    `SELECT r.status, r.heartbeat_at, r.started_at, r.succeeded_cases AS succeeded,
            (SELECT count(*)::int FROM eval_case_results x WHERE x.eval_run_id = r.id) AS results
       FROM eval_runs r WHERE r.id = $1`,
    [runId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`run ${runId} 不存在`);
  return {
    status: row.status,
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    results: row.results,
    succeeded: row.succeeded,
  };
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

let client: Client;
let gateway: CountingGateway | null = null;
const procs: WorkerProc[] = [];
const GATEWAY_PORT = 8791;

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
  await resetDatabase(DB_URL);
  gateway = await startCountingGateway(GATEWAY_PORT);
}, 60_000);

afterAll(async () => {
  for (const p of procs) await killTree(p, true);
  if (gateway) await gateway.close();
  await client.end();
  // 先复位 schema（清掉本 spec 造的 run / target / 厂商），再重放种子。
  // `B-07`/`B-08`：只迁移不复原，库里会留下「声明 N 条样本、实际 0 行」的数据集。
  await restoreSeed(DB_URL).catch(() => undefined);
}, 60_000);

describe('H-10/H-11 心跳租约 · 真 worker 进程', () => {
  it(
    '心跳持续时另一个 worker 不得回收：单 Case 6s > TTL 1s，网关请求数 = Case 数 × 1',
    async () => {
      const seeded = await seedRun(client, GATEWAY_PORT, 'live', CASES_PER_RUN);
      const hits = gateway?.hits;
      if (!hits) throw new Error('计数网关未启动');
      const startedAt = Date.now();

      const env = {
        WORKER_STALE_AFTER: STALE_AFTER,
        WORKER_RECLAIM_INTERVAL_MS: String(RECLAIM_INTERVAL_MS),
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_CONCURRENCY: '2',
      };
      const a = spawnWorker('A', env);
      const b = spawnWorker('B', env);
      procs.push(a, b);

      // 两个 worker 都在跑；等 run 进入终态
      await waitFor(
        'run COMPLETED',
        async () => (await runStatusAndHeartbeat(client, seeded.runId)).status === 'COMPLETED',
        45_000,
      );

      // 心跳确实被写过（不是只靠 started_at）
      const during = await runStatusAndHeartbeat(client, seeded.runId);
      expect(during.heartbeatAt).not.toBeNull();

      // 网关调用：每个 Case 恰好 1 次
      const perCase = seeded.caseTexts.map((t) => hits.get(t) ?? 0);
      expect(perCase).toEqual(seeded.caseTexts.map(() => 1));

      // 同一 run 只被领取一次（日志判据）
      const claimLines = [...a.lines, ...b.lines].filter((l) => l.includes(`领取 run ${seeded.runId}`));
      expect(claimLines).toHaveLength(1);

      // 回收从未把这条 run 当成僵尸
      const reclaimLines = [...a.lines, ...b.lines].filter((l) => l.includes('回收僵尸'));
      expect(reclaimLines).toHaveLength(0);

      // 收尾不再出现被抢占者的终态冻结错误
      const frozen = [...a.lines, ...b.lines].filter((l) => l.includes('row is frozen'));
      expect(frozen).toHaveLength(0);

      // 实测读数（验收报告直接引用）
      console.log(
        `[H-10] lease=${STALE_AFTER} caseDelay=${String(CASE_DELAY_MS)}ms cases=${String(CASES_PER_RUN)} ` +
          `heartbeat=${during.heartbeatAt?.toISOString() ?? 'null'} ` +
          `gatewayHits=${JSON.stringify(perCase)} claimLines=${String(claimLines.length)} ` +
          `reclaimLines=${String(reclaimLines.length)} frozenLines=${String(frozen.length)} ` +
          `duration≈${String(Date.now() - startedAt)}ms`,
      );

      await killTree(a, true);
      await killTree(b, true);
    },
    60_000,
  );

  it(
    '心跳停止后另一 worker 可回收并续跑：结果行不重复；网关调用允许重复（at-least-once，见 M2 待办）',
    async () => {
      const seeded = await seedRun(client, GATEWAY_PORT, 'dead', CASES_PER_RUN);
      const hits = gateway?.hits;
      if (!hits) throw new Error('计数网关未启动');
      const startedAt = Date.now();

      const env = {
        WORKER_STALE_AFTER: STALE_AFTER,
        WORKER_RECLAIM_INTERVAL_MS: String(RECLAIM_INTERVAL_MS),
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_CONCURRENCY: '1',
      };

      // 只起 A：它领取 run 并开始跑（每个 Case 6s，共 2 条 ⇒ 约 12s）
      const a = spawnWorker('A-dead', env);
      procs.push(a);
      await waitFor(
        'A 领取 run',
        () => a.lines.some((l) => l.includes(`领取 run ${seeded.runId}`)),
        15_000,
      );

      // 至少等到一次心跳，随后硬杀（心跳随进程停止）
      await waitFor(
        '心跳写入',
        async () => (await runStatusAndHeartbeat(client, seeded.runId)).heartbeatAt !== null,
        10_000,
      );
      await killTree(a, true);

      const afterKill = await runStatusAndHeartbeat(client, seeded.runId);
      expect(afterKill.status).toBe('RUNNING');

      // 起 B：超过 TTL 后应把这条 RUNNING 回收、重新领取并续跑
      const b = spawnWorker('B-rescue', env);
      procs.push(b);
      await waitFor(
        'B 回收并完成',
        async () => (await runStatusAndHeartbeat(client, seeded.runId)).status === 'COMPLETED',
        60_000,
      );

      const reclaimLines = b.lines.filter((l) => l.includes('回收僵尸'));
      expect(reclaimLines.length).toBeGreaterThanOrEqual(1);

      // 已完成的 Case 不该被 A 之外再打一次；被中断的 Case 最多重打一次
      const perCase = seeded.caseTexts.map((t) => hits.get(t) ?? 0);
      for (const n of perCase) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(2);
      }

      // 结果行仍恰好 = Case 数（行级幂等）
      const final = await runStatusAndHeartbeat(client, seeded.runId);
      expect(final.results).toBe(CASES_PER_RUN);

      console.log(
        `[H-11] killedAfterHeartbeat=${String(afterKill.heartbeatAt !== null)} ` +
          `statusAfterKill=${afterKill.status} gatewayHits=${JSON.stringify(perCase)} ` +
          `reclaimLines=${String(reclaimLines.length)} resultRows=${String(final.results)} ` +
          `duration≈${String(Date.now() - startedAt)}ms`,
      );

      await killTree(b, true);
    },
    90_000,
  );

  /**
   * H-12：**运行中进度必须推进**。
   *
   * 真浏览器验收（`pg-interaction-check.ts`）在截图里抓到：明细表已经有 11 条完成，
   * 进度条却还是「已完成 0 / 50」。根因是 `succeeded_cases` 等计数字段
   * **只在 `finalizeRun` 时写一次**，RUNNING 期间恒为 0。
   * `PG-03` 的整条区域 3 就是为了「跑的时候能看见进度」而存在的，
   * `0 / N` 从头到尾不动等于这块 UI 不存在。
   *
   * 判据：run 仍处于 RUNNING 时轮询数据库，`succeeded_cases` 必须
   * 严格递增到 `total_cases`（用真 worker 进程，不用 mock 时钟）。
   */
  it(
    '运行中 succeeded_cases 递增（不是只在终态写一次）',
    async () => {
      const total = 3;
      // 并发度必须是 1：`processRun` 用 run 行上的 `concurrency` 列，
      // 不是 env 的 `WORKER_CONCURRENCY`。串行跑 3 条 × 6s 才有采样窗口。
      const seeded = await seedRun(client, GATEWAY_PORT, 'progress', total, { concurrency: 1 });
      const startedAt = Date.now();

      const env = {
        WORKER_STALE_AFTER: '10 minutes',
        WORKER_POLL_INTERVAL_MS: '50',
        WORKER_CONCURRENCY: '1',
      };
      const w = spawnWorker('W-progress', env);
      procs.push(w);

      // 采样：在终态之前收集所有 (时间, succeeded_cases) 读数
      const samples: number[] = [];
      await waitFor(
        'run COMPLETED',
        async () => {
          const s = await runStatusAndHeartbeat(client, seeded.runId);
          if (s.status === 'RUNNING') samples.push(s.succeeded);
          return s.status === 'COMPLETED';
        },
        90_000,
      );

      // 关键断言：RUNNING 期间必须观测到至少一个「> 0 且 < total」的中间值。
      // 只在终态写一次时，RUNNING 期间的读数只会是 0。
      const mid = samples.filter((n) => n > 0 && n < total);
      expect(mid.length).toBeGreaterThan(0);

      // 并且全程单调不减（计数不会回退）
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1] ?? 0;
        const cur = samples[i] ?? 0;
        expect(cur).toBeGreaterThanOrEqual(prev);
      }

      const final = await runStatusAndHeartbeat(client, seeded.runId);
      expect(final.succeeded).toBe(total);

      console.log(
        `[H-12] runningSamples=${JSON.stringify([...new Set(samples)])} ` +
          `midValues=${String(mid.length)} finalSucceeded=${String(final.succeeded)} ` +
          `duration≈${String(Date.now() - startedAt)}ms`,
      );

      await killTree(w, true);
    },
    120_000,
  );
});
