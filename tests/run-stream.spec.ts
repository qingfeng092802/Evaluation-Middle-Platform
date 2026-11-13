/**
 * SSE 事件流（Batch 3 · 交付物 2/3/5）。
 *
 * 原文三条：
 *  - 「`GET /api/runs/:id/stream`，事件类型 `snapshot` / `case` / `status` / `heartbeat` / `error`；
 *     服务端 `LISTEN run_progress` 独立连接，worker 写库后 `NOTIFY`」；
 *  - 「`Last-Event-ID` 断线续传：**进度不倒退、不重复计数**」；
 *  - 「`PROGRESS_RESUME_POLICY.mode = 'snapshot_only'`：重连第一步永远是
 *     `GET /api/runs/:id`，**不做事件回放**」。
 *
 * ## 为什么这几条必须对着真库测
 *
 * 三条都依赖「数据库真的把 NOTIFY 发出来了」：
 *
 *  - 忘了 `NOTIFY` ⇒ 流永远只有 snapshot，页面**看起来正常**（进度停在 0），
 *    因为心跳还在跳；
 *  - `LISTEN` 复用连接池 ⇒ 通知随机丢失，本机大概率不重现；
 *  - 重连时把 `completedCount` 按事件累加 ⇒ 重连一次就多计一遍，
 *    进度条冲到 110%，而且**只有断线的人**能看见。
 *
 * 所以这里用真库 + 真 `LISTEN`：测试自己起一条独立连接发 `NOTIFY`，
 * 断言流真的把它翻译成了 `case` 事件。
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { restoreSeed } from './support/fixtures.js';
import { runEventStream, type StreamFrame } from '../lib/api/services/run-stream.js';
import { frameMatchesPayload, decodeStreamEventId } from '@eval-platform/contracts';

const DB_URL = databaseUrl();

let admin: Client;

async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await admin.query<T>(sql, params);
  const row = res.rows[0];
  if (!row) throw new Error(`期望一行：${sql}`);
  return row;
}

/** 造一个 PENDING run（1 条 Case），返回各 id。 */
async function seedRun(tag: string): Promise<{ runId: string; versionId: string; caseId: string }> {
  const ds = await q<{ id: string }>(`INSERT INTO datasets (name, owner_id) VALUES ($1,'t') RETURNING id`, [
    `ds-sse-${tag}`,
  ]);
  const dv = await q<{ id: string }>(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1,1,1,$2,'import','t') RETURNING id`,
    [ds.id, `sha256:sse-${tag}`],
  );
  const dc = await q<{ id: string }>(
    `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input, metadata)
     VALUES ($1,$2,0,'{"query":"x"}'::jsonb,'{}'::jsonb) RETURNING id`,
    [dv.id, `c-${tag}`],
  );
  const mp = await q<{ id: string }>(
    `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked, is_active)
     VALUES ($1,'openai_compatible','http://127.0.0.1:1','plain','m-••••k',true) RETURNING id`,
    [`mp-sse-${tag}`],
  );
  const tg = await q<{ id: string }>(
    `INSERT INTO targets (name, kind, current_version_no, owner_id) VALUES ($1,'t1_prompt',1,'t') RETURNING id`,
    [`tg-sse-${tag}`],
  );
  const tv = await q<{ id: string }>(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1,1,'t1_prompt',$2,'m','{{query}}',0,8,'t') RETURNING id`,
    [tg.id, mp.id],
  );
  const run = await q<{ id: string }>(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1,$2,$3,2,'{"priceSnapshot":[]}'::jsonb,'{}'::jsonb,'test','t',1,'PENDING') RETURNING id`,
    [`run-sse-${tag}`, dv.id, tv.id],
  );
  return { runId: run.id, versionId: dv.id, caseId: dc.id };
}

/**
 * 推进 run 状态并写一条结果，然后 `NOTIFY`。
 *
 * 这模拟的是 worker 写库后的动作 —— 顺序不能换：先落行再通知，
 * 否则订阅方回查时看不到新数据，表现出来的症状是「事件到了但计数没变」。
 */
/**
 * 把 run 推到 `RUNNING`（状态机只允许 PENDING → RUNNING）。
 *
 * 直接 PENDING → COMPLETED 会被 `trg_eval_runs_guard` 拒成
 * `illegal status transition` —— 这不是测试噪音，而是「终态必须经过 RUNNING」
 * 的数据库事实。夹具必须绕开它，否则测的就不是业务路径。
 */
async function startRun(runId: string): Promise<void> {
  await admin.query(
    `UPDATE eval_runs SET status = 'RUNNING', started_at = now() WHERE id = $1 AND status = 'PENDING'`,
    [runId],
  );
}

async function advance(
  runId: string,
  caseId: string,
  opts: { status: 'RUNNING' | 'COMPLETED'; seq: number; score?: number },
): Promise<void> {
  // 顺序照抄 worker：先落结果行 → 再刷计数 → 最后才进终态。
  // 反过来的话（先 COMPLETED 再刷计数）计数那条 UPDATE 会被 `status = 'RUNNING'`
  // 条件挡掉，夹具就造出一个「终态但计数为 0」的假状态 —— 测出来的不是业务路径。
  await startRun(runId);
  await admin.query(
    `INSERT INTO eval_case_results
       (eval_run_id, dataset_case_id, case_key, output_text, status, score, passed, latency_ms, tokens_in, tokens_out, cost_target, cost_judge)
     VALUES ($1,$2,$3,'out','OK',$4,true,12,7,3,0,0)
     ON CONFLICT (eval_run_id, case_key) DO NOTHING`,
    [runId, caseId, `c-${runId.slice(0, 8)}-${String(opts.seq)}`, opts.score ?? 0.8],
  );
  await admin.query(
    `UPDATE eval_runs r
        SET succeeded_cases = s.ok, failed_cases = s.bad, skipped_cases = 0
       FROM (SELECT count(*) FILTER (WHERE status = 'OK') AS ok,
                    count(*) FILTER (WHERE status <> 'OK') AS bad
               FROM eval_case_results WHERE eval_run_id = $1) s
      WHERE r.id = $1 AND r.status = 'RUNNING'`,
    [runId],
  );
  if (opts.status === 'COMPLETED') {
    await admin.query(`UPDATE eval_runs SET status = 'COMPLETED', finished_at = now() WHERE id = $1`, [
      runId,
    ]);
  }
  await admin.query(`SELECT pg_notify('run_progress', $1)`, [runId]);
}

/** 收集前 N 帧（或直到流结束 / 超时）。 */
async function take(
  stream: AsyncGenerator<StreamFrame>,
  n: number,
  ms = 5000,
): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  const deadline = Date.now() + ms;
  while (out.length < n && Date.now() < deadline) {
    const next = await Promise.race([
      stream.next(),
      new Promise<IteratorResult<StreamFrame>>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 200),
      ),
    ]);
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

/**
 * 一直读到满足条件为止（返回**全部**收到的帧）。
 *
 * 不能用「`take(1)` 然后断言里面有 case」：`take` 会把时间窗口里先到的
 * heartbeat 一起吃掉并丢弃，剩下的 `case` 就永远等不到了。
 */
async function takeUntil(
  stream: AsyncGenerator<StreamFrame>,
  pred: (f: StreamFrame) => boolean,
  ms = 5000,
): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      stream.next(),
      new Promise<IteratorResult<StreamFrame>>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 200),
      ),
    ]);
    if (next.done) break;
    out.push(next.value);
    if (pred(next.value)) break;
  }
  return out;
}

beforeAll(async () => {
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
  await resetDatabase(DB_URL);
}, 60_000);

afterAll(async () => {
  await admin.end();
  await restoreSeed(DB_URL).catch(() => undefined);
}, 60_000);

describe('runEventStream · 首个事件恒为 snapshot（snapshot_only）', () => {
  it('连上就先给全量快照，status 与库一致', async () => {
    const { runId } = await seedRun('snap');
    const stream = runEventStream({ runId, heartbeatMs: 60_000 });
    const first = await stream.next();
    await stream.return?.(undefined);

    expect(first.done).toBe(false);
    const frame = first.value!;
    expect(frame.event).toBe('snapshot');
    expect(frame.data.type).toBe('snapshot');
    expect(frameMatchesPayload(frame)).toBe(true);
    if (frame.data.type === 'snapshot') {
      expect(frame.data.runId).toBe(runId);
      expect(frame.data.status).toBe('PENDING');
      expect(frame.data.counts.totalCases).toBe(1);
    }
  });

  it('帧 id 可被 encode/decode 往返（客户端 Last-Event-ID 的来源）', async () => {
    const { runId } = await seedRun('snap-id');
    const stream = runEventStream({ runId, heartbeatMs: 60_000 });
    const first = await stream.next();
    await stream.return?.(undefined);
    const decoded = decodeStreamEventId(first.value!.id);
    expect(decoded?.runId).toBe(runId);
    expect(decoded?.seq).toBe(0);
  });
});

describe('runEventStream · NOTIFY ⇒ case 事件', () => {
  it('worker 写库并 NOTIFY 后，流里出现 case 事件且计数递增', async () => {
    const { runId, caseId } = await seedRun('case');
    const stream = runEventStream({ runId, heartbeatMs: 60_000 });

    const first = await stream.next();
    expect(first.value!.event).toBe('snapshot');

    // 等 LISTEN 真正生效再推进，否则通知会打在订阅之前（这不是流的问题）
    await new Promise((r) => setTimeout(r, 300));
    await advance(runId, caseId, { status: 'RUNNING', seq: 1 });

    const frames = await takeUntil(stream, (f) => f.event === 'case', 4000);
    await stream.return?.(undefined);

    const caseFrame = frames.find((f) => f.event === 'case');
    expect(caseFrame, 'NOTIFY 没有变成 case 事件（LISTEN 没接上？）').toBeDefined();
    if (caseFrame?.data.type === 'case') {
      expect(caseFrame.data.completedCount).toBe(1);
      expect(caseFrame.data.totalCount).toBe(1);
    }
  });
});

describe('runEventStream · 终态 ⇒ status 事件并结束', () => {
  it('COMPLETED 后推送 status，随后流结束', async () => {
    const { runId, caseId } = await seedRun('term');
    const stream = runEventStream({ runId, heartbeatMs: 60_000 });

    await stream.next();
    await new Promise((r) => setTimeout(r, 300));
    await advance(runId, caseId, { status: 'COMPLETED', seq: 1 });

    const frames = await takeUntil(stream, (f) => f.event === 'status', 4000);
    await stream.return?.(undefined);

    const statusFrame = frames.find((f) => f.event === 'status');
    expect(statusFrame, '终态没有发出 status 事件，客户端会一直转圈').toBeDefined();
    if (statusFrame?.data.type === 'status') {
      expect(statusFrame.data.to).toBe('COMPLETED');
    }
  });
});

describe('runEventStream · 断线续传（snapshot_only，不回放）', () => {
  it('带 Last-Event-ID 重连：仍然先发 snapshot，不补发历史事件', async () => {
    const { runId, caseId } = await seedRun('resume');
    await advance(runId, caseId, { status: 'RUNNING', seq: 1 });

    // 模拟「客户端已经收到过 seq=0..3，现在重连」
    const stream = runEventStream({
      runId,
      lastEventId: `${runId}:3`,
      heartbeatMs: 60_000,
    });
    const first = await stream.next();
    await stream.return?.(undefined);

    expect(first.value!.event).toBe('snapshot');
    // 不回放：重连后的第一帧就是当前真相，而不是 seq=4 的增量
    if (first.value!.data.type === 'snapshot') {
      expect(first.value!.data.counts.succeededCases).toBe(1);
    }
  });

  it('进度不倒退、不重复计数：重连后的 completedCount 等于库里的真实条数', async () => {
    const { runId, caseId } = await seedRun('nodup');

    // 第一条连接：跑完 1 条
    const first = runEventStream({ runId, heartbeatMs: 60_000 });
    await first.next();
    await new Promise((r) => setTimeout(r, 300));
    await advance(runId, caseId, { status: 'RUNNING', seq: 1 });
    await takeUntil(first, (f) => f.event === 'case', 4000);
    await first.return?.(undefined);

    // 断线重连（带着上一段的 id）
    const second = runEventStream({ runId, lastEventId: `${runId}:5`, heartbeatMs: 60_000 });
    const snapshot = await second.next();
    await second.return?.(undefined);

    if (snapshot.value!.data.type === 'snapshot') {
      const c = snapshot.value!.data.counts;
      // 真实的 1 条，而不是「1 条 + 上次累加过的 1 条」
      expect(c.succeededCases + c.failedCases + c.skippedCases).toBe(1);
    }
  });
});

describe('runEventStream · heartbeat', () => {
  it('静默期按间隔补心跳（保证代理不判死连接）', async () => {
    const { runId } = await seedRun('hb');
    const stream = runEventStream({ runId, heartbeatMs: 120 });
    await stream.next(); // snapshot
    const frames = await take(stream, 2, 3000);
    await stream.return?.(undefined);
    expect(frames.some((f) => f.event === 'heartbeat')).toBe(true);
  });
});
