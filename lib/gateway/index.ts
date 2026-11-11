/**
 * 网关客户端（OpenAI 兼容 `POST /v1/chat/completions`）。
 *
 * 这是**真实网关客户端**，不是 fixture 客户端 —— M2 换成 LiteLLM Proxy 时
 * 只需改 `baseUrl`，本文件接口不变（SPEC-M1 §3.1 拆除清单）。
 *
 * 失败语义（`[BE-03]` 交付物 4）：
 *  - 5xx / 网络错误 → 有限次指数退避；仍失败 ⇒ `FAILED`
 *  - 429 → 同样退避；仍 429 ⇒ `QUOTA_EXCEEDED`
 *  - 超时 ⇒ `TIMEOUT`
 * 三类都**不产分数**（`score = NULL`）。绝不能把失败写成 0 分：
 * 「模型没答」与「模型答错」在任何报表里都是两件事。
 */
import type { CaseResultStatus } from '@eval-platform/contracts';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly extraParams?: Record<string, unknown> | undefined;
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number | undefined;
}

export interface ChatSuccess {
  readonly ok: true;
  readonly content: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
}

export interface ChatFailure {
  readonly ok: false;
  readonly status: CaseResultStatus;
  readonly message: string;
  readonly latencyMs: number;
}

export type ChatOutcome = ChatSuccess | ChatFailure;

/** 退避基数与上限：最多 3 次重试（1s → 2s → 4s 封顶）。 */
const BACKOFF_MS = [500, 1000, 2000] as const;
const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * 发一次补全请求，内部已含重试与分类。
 *
 * 返回 `ChatOutcome` 而**不抛异常**：让 runner 的失败路径只有一处
 * （把 outcome 落成 `eval_case_results` 的一行），异常留给真正的程序缺陷。
 */
export async function chatComplete(req: ChatRequest): Promise<ChatOutcome> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const body = JSON.stringify({
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    ...(req.extraParams ?? {}),
  });
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastFailure: ChatFailure = {
    ok: false,
    status: 'FAILED',
    message: '未发出请求',
    latencyMs: 0,
  };

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${req.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const isTimeout = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
      lastFailure = {
        ok: false,
        status: isTimeout ? 'TIMEOUT' : 'FAILED',
        message: isTimeout ? `网关超时（${timeoutMs}ms）` : `网关不可达：${(err as Error).message}`,
        latencyMs,
      };
      // 超时 / 不可达也退避重试：网关刚起、连接被拒时立刻重试往往能成功
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt] as number);
        continue;
      }
      return lastFailure;
    }

    if (res.status === 429) {
      const latencyMs = Date.now() - startedAt;
      lastFailure = {
        ok: false,
        status: 'QUOTA_EXCEEDED',
        message: '网关返回 429（限流 / 配额耗尽）',
        latencyMs,
      };
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt] as number);
        continue;
      }
      return lastFailure;
    }

    if (res.status >= 500) {
      const latencyMs = Date.now() - startedAt;
      lastFailure = {
        ok: false,
        status: 'FAILED',
        message: `网关返回 ${res.status}`,
        latencyMs,
      };
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt] as number);
        continue;
      }
      return lastFailure;
    }

    if (!res.ok) {
      // 4xx 不重试：重试不会改变结果，只会拖长跑批
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: 'FAILED',
        message: `网关返回 ${res.status}：${text.slice(0, 200)}`,
        latencyMs: Date.now() - startedAt,
      };
    }

    // 成功
    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch {
      return {
        ok: false,
        status: 'PARSE_ERROR',
        message: '网关响应不是合法 JSON',
        latencyMs: Date.now() - startedAt,
      };
    }

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return {
        ok: false,
        status: 'PARSE_ERROR',
        message: '响应缺少 choices[0].message.content',
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      content,
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
    };
  }

  return lastFailure;
}
