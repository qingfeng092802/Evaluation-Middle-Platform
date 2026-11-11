/**
 * 本地 fixture 回显网关（OpenAI 兼容，**仅绑 127.0.0.1**）。
 *
 * M1 的模型输出由它提供，目的是证明「T1 链路真的走 HTTP」，
 * 而不是在 worker 里直接拼一个假响应。
 *
 * 确定性规则（SPEC-M1 §3.1）：
 *  - `content` = `"[fixture] " + 最后一条 user 内容的前 200 字符`；
 *  - `usage` 由 messages 的**字符数**确定性推导；
 *  - **禁止随机数、禁止时间戳进响应体** —— 同一 messages 必须逐字节相同。
 *
 * 错误注入：
 *  - 查询参数 `?fail=timeout|500|429`（单请求，用于手动验证）；
 *  - 环境变量 `FIXTURE_FAIL_MODE`（进程级，AC-7 用）；
 *  - 环境变量 `FIXTURE_DELAY_MS`（每次响应前 sleep，仅影响时序）。
 *
 * 安全：不发起任何外部请求、不做 DNS 解析、不监听 0.0.0.0。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env['FIXTURE_PORT'] ?? 8787);
const FAIL_MODE = (process.env['FIXTURE_FAIL_MODE'] ?? '').trim();
const DELAY_MS = Number(process.env['FIXTURE_DELAY_MS'] ?? 0);
const PREFIX = '[fixture] ';
const ECHO_LIMIT = 200;

interface ChatBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  temperature?: number;
  max_tokens?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 确定性 usage：prompt = 全部消息字符数；completion = 回显内容字符数。 */
function deterministicUsage(messages: Array<{ content?: string }>, content: string): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptChars = messages.reduce((n, m) => n + (m.content ?? '').length, 0);
  const promptTokens = Math.ceil(promptChars / 4);
  const completionTokens = Math.ceil(content.length / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/** 回显内容：最后一条 user 消息的前 200 字符。 */
function echoContent(messages: Array<{ role?: string; content?: string }>): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = lastUser?.content ?? '';
  return `${PREFIX}${text.slice(0, ECHO_LIMIT)}`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', failMode: FAIL_MODE || null });
    return;
  }

  if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  // 错误注入优先级：查询参数覆盖进程级开关
  const fail = url.searchParams.get('fail') ?? FAIL_MODE;
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  if (fail === 'timeout') {
    // 挂住不响应，由客户端超时
    await sleep(120_000);
    return;
  }
  if (fail === '500') {
    sendJson(res, 500, { error: { message: 'fixture injected 500' } });
    return;
  }
  if (fail === '429') {
    sendJson(res, 429, { error: { message: 'fixture injected 429' } });
    return;
  }

  // 读请求体（有大小上限，避免被超大 body 拖死）
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) {
      sendJson(res, 413, { error: { message: 'body too large' } });
      return;
    }
    chunks.push(buf);
  }

  let body: ChatBody;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatBody;
  } catch {
    sendJson(res, 400, { error: { message: 'invalid json body' } });
    return;
  }

  const messages = body.messages ?? [];
  const content = echoContent(messages);
  const usage = deterministicUsage(messages, content);

  sendJson(res, 200, {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    model: body.model ?? 'fixture-echo-1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage,
  });
}

export function startFixtureGateway(): Promise<{ close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: { message: (err as Error).message } });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 只绑 127.0.0.1：不监听 0.0.0.0，避免被同网段访问
    server.listen(PORT, HOST, () => {
      console.log(`[fixture-gateway] listening on http://${HOST}:${PORT}`);
      if (FAIL_MODE) console.log(`[fixture-gateway] FAIL_MODE=${FAIL_MODE}`);
      if (DELAY_MS > 0) console.log(`[fixture-gateway] DELAY_MS=${DELAY_MS}`);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

// 直接执行时启动（`npm run fixture`）
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('fixture-gateway/index.ts') ||
    process.argv[1].endsWith('fixture-gateway\\index.ts'));

if (isMain) {
  startFixtureGateway().catch((err: unknown) => {
    console.error('[fixture-gateway] 启动失败：', err);
    process.exitCode = 1;
  });
}
