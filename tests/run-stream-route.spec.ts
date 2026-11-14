/**
 * `GET /api/runs/{runId}/stream` 的 **HTTP 线上形状**（Batch 3 · 交付物 2）。
 *
 * `run-stream.spec.ts` 锁的是事件源（`runEventStream`）本身；这里补的是
 * 「它被翻译成 SSE 字节之后还是不是那个东西」。这两层会各自坏掉，且坏法不同：
 *
 *  - **帧格式坏了**（少一个空行、`id:` 没写）：浏览器 `EventSource` 不会报错，
 *    它只会**永远等一个不完整的事件** —— 页面静默地不动；
 *  - **`Last-Event-ID` 被当成回放请求**：重连后补发历史事件，配合客户端累加
 *    就成了双倍计数（`snapshot_only` 明确禁止）；
 *  - **run 不存在时仍然返回 200 + 事件流**：`EventSource` 会按 `retry:` 无限重连，
 *    服务端每次都为一条不存在的 run 建一条 `LISTEN` 连接。
 *
 * 所以这里走真实的 Route Handler 导出（与真服务器同一份代码，只少了 HTTP 传输层），
 * 用真库，读它返回的 `ReadableStream` 原始字节。
 */
import { NextRequest } from 'next/server';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSseDataLine } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { closeDb } from '../db/schema/index.js';
import { restoreSeed } from './support/fixtures.js';
import * as streamRoute from '../app/api/runs/[runId]/stream/route.js';

const DB_URL = databaseUrl();
const BASE = 'http://localhost:3000';

let admin: Client;

async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await admin.query<T>(sql, params);
  const row = res.rows[0];
  if (!row) throw new Error(`期望一行：${sql}`);
  return row;
}

/** 造一个 PENDING run（1 条 Case）。 */
async function seedRun(tag: string): Promise<{ runId: string; caseId: string }> {
  const ds = await q<{ id: string }>(`INSERT INTO datasets (name, owner_id) VALUES ($1,'t') RETURNING id`, [
    `ds-route-${tag}`,
  ]);
  const dv = await q<{ id: string }>(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1,1,1,$2,'import','t') RETURNING id`,
    [ds.id, `sha256:route-${tag}`],
  );
  const dc = await q<{ id: string }>(
    `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input, metadata)
     VALUES ($1,$2,0,'{"query":"x"}'::jsonb,'{}'::jsonb) RETURNING id`,
    [dv.id, `c-${tag}`],
  );
  const mp = await q<{ id: string }>(
    `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked, is_active)
     VALUES ($1,'openai_compatible','http://127.0.0.1:1','plain','m-••••k',true) RETURNING id`,
    [`mp-route-${tag}`],
  );
  const tg = await q<{ id: string }>(
    `INSERT INTO targets (name, kind, current_version_no, owner_id) VALUES ($1,'t1_prompt',1,'t') RETURNING id`,
    [`tg-route-${tag}`],
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
    [`run-route-${tag}`, dv.id, tv.id],
  );
  return { runId: run.id, caseId: dc.id };
}

/** 推进 run 并写一条结果，最后 `NOTIFY`（照抄 worker 的顺序）。 */
async function advance(runId: string, caseId: string, terminal: boolean): Promise<void> {
  await admin.query(
    `UPDATE eval_runs SET status = 'RUNNING', started_at = now() WHERE id = $1 AND status = 'PENDING'`,
    [runId],
  );
  await admin.query(
    `INSERT INTO eval_case_results
       (eval_run_id, dataset_case_id, case_key, output_text, status, score, passed, latency_ms, tokens_in, tokens_out, cost_target, cost_judge)
     VALUES ($1,$2,$3,'out','OK',0.8,true,12,7,3,0,0)
     ON CONFLICT (eval_run_id, case_key) DO NOTHING`,
    [runId, caseId, `c-${runId.slice(0, 8)}`],
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
  if (terminal) {
    await admin.query(`UPDATE eval_runs SET status = 'COMPLETED', finished_at = now() WHERE id = $1`, [
      runId,
    ]);
  }
  await admin.query(`SELECT pg_notify('run_progress', $1)`, [runId]);
}

// ---------------------------------------------------------------------------
// SSE 字节读取器
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

/**
 * 从 `ReadableStream` 里按 `\n\n` 切帧。
 *
 * 超时返回 `null` 表示「这段时间没有新帧」，**不代表流已结束** ——
 * 判定流结束要看 `reader.read()` 的 `done`，两者混用会把「还没写」误判成「写完了」。
 */
class SseReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  /**
   * 未消费的 `read()` 要留着复用。每轮新起一个再和超时赛跑的话，
   * 超时赢下的那次读仍然挂着，下一块数据交给它却没人 await —— 帧被静默吞掉。
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
        if (raw.trim() === '') continue; // 心跳注释 / 空帧
        return parseFrame(raw);
      }
      const remaining = Math.max(1, deadline - Date.now());
      const res = await Promise.race([
        this.readOnce(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.min(remaining, 200))),
      ]);
      if (res === 'timeout') continue;
      this.pending = null;
      if (res.done) return null;
      this.buffer += this.decoder.decode(res.value, { stream: true });
    }
    return null;
  }

  /** 读到满足条件为止，返回**全部**经过的帧（心跳不吃掉业务帧）。 */
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

  async closed(ms = 5000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const res = await Promise.race([
        this.reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200)),
      ]);
      if (res === 'timeout') continue;
      if (res.done) return true;
      this.buffer += this.decoder.decode(res.value, { stream: true });
    }
    return false;
  }
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
  await closeDb().catch(() => undefined);
  await restoreSeed(DB_URL).catch(() => undefined);
}, 60_000);

describe('GET /api/runs/:id/stream · 线上形状', () => {
  it('200 + text/event-stream，首帧是 snapshot 且 id 为 <runId>:0', async () => {
    const { runId } = await seedRun('head');
    const req = new NextRequest(`${BASE}/api/runs/${runId}/stream`);
    const res = await streamRoute.GET(req, { params: Promise.resolve({ runId }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    expect(res.headers.get('cache-control') ?? '').toContain('no-cache');

    const reader = res.body!.getReader();
    const sse = new SseReader(reader);
    const first = await sse.next(4000);
    await reader.cancel();

    expect(first, '连上之后没有任何字节').not.toBeNull();
    expect(first!.event).toBe('snapshot');
    expect(first!.id).toBe(`${runId}:0`);
    // 帧必须是「单行 data: + 空行结尾」：浏览器按空行切事件，少一个就永远等不完整
    const parsed = parseSseDataLine(`data: ${first!.data}`);
    expect(parsed?.type).toBe('snapshot');
  });

  it('NOTIFY ⇒ 线上出现 case 帧，data 可被契约解析', async () => {
    const { runId, caseId } = await seedRun('case');
    const req = new NextRequest(`${BASE}/api/runs/${runId}/stream`);
    const res = await streamRoute.GET(req, { params: Promise.resolve({ runId }) });
    const reader = res.body!.getReader();
    const sse = new SseReader(reader);

    const snap = await sse.next(4000);
    expect(snap?.event).toBe('snapshot');

    // 等 LISTEN 真正生效（服务端在 yield 首帧前已订阅，这里只是留出窗口）
    await new Promise((r) => setTimeout(r, 300));
    await advance(runId, caseId, false);

    const frames = await sse.until((f) => f.event === 'case', 4000);
    await reader.cancel();

    const caseFrame = frames.find((f) => f.event === 'case');
    expect(caseFrame, 'NOTIFY 没有变成 case 帧（LISTEN 没接上？）').toBeDefined();
    const parsed = parseSseDataLine(`data: ${caseFrame!.data}`);
    expect(parsed?.type).toBe('case');
    if (parsed?.type === 'case') {
      expect(parsed.completedCount).toBe(1);
      expect(parsed.totalCount).toBe(1);
    }
  });

  it('终态 ⇒ status 帧之后流关闭（EventSource 不会无限重连已结束的 run）', async () => {
    const { runId, caseId } = await seedRun('term');
    const req = new NextRequest(`${BASE}/api/runs/${runId}/stream`);
    const res = await streamRoute.GET(req, { params: Promise.resolve({ runId }) });
    const reader = res.body!.getReader();
    const sse = new SseReader(reader);

    await sse.next(4000);
    await new Promise((r) => setTimeout(r, 300));
    await advance(runId, caseId, true);

    const frames = await sse.until((f) => f.event === 'status', 4000);
    const statusFrame = frames.find((f) => f.event === 'status');
    expect(statusFrame, '终态没有发出 status 帧，客户端会一直转圈').toBeDefined();

    expect(await sse.closed(4000)).toBe(true);
  });

  it('带 Last-Event-ID 重连：首帧仍是 snapshot，不补发历史事件（snapshot_only）', async () => {
    const { runId, caseId } = await seedRun('resume');
    await advance(runId, caseId, false);

    const req = new NextRequest(`${BASE}/api/runs/${runId}/stream`, {
      headers: { 'last-event-id': `${runId}:9` },
    });
    const res = await streamRoute.GET(req, { params: Promise.resolve({ runId }) });
    const reader = res.body!.getReader();
    const sse = new SseReader(reader);

    const first = await sse.next(4000);
    const second = await sse.next(600);
    await reader.cancel();

    expect(first?.event).toBe('snapshot');
    // 不回放：紧接着不应出现「历史」的 case 帧
    expect(second === null || second.event !== 'case').toBe(true);
    const parsed = parseSseDataLine(`data: ${first!.data}`);
    if (parsed?.type === 'snapshot') {
      expect(parsed.counts.succeededCases).toBe(1);
    }
  });

  it('run 不存在 ⇒ 404 JSON，而不是一条永远 200 的事件流', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const req = new NextRequest(`${BASE}/api/runs/${missing}/stream`);
    const res = await streamRoute.GET(req, { params: Promise.resolve({ runId: missing }) });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});
