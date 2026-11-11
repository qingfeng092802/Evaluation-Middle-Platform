/**
 * 浏览器侧 API 客户端（`[FE-02]` / `[FE-03]` 的真实数据来源）。
 *
 * 为什么不让页面各自 `fetch(...).then(r => r.json())`：
 *
 *  1. **出站契约校验只做一次**。服务端 `ok()` 在写出一侧 `parse()` 过，
 *     前端在读入一侧再 `parse()` 一遍——两边都用同一份 Zod schema，
 *     这才是「前后端不漂移」的闭环。不校验的话，后端加字段/改类型时页面只会静默渲染 `undefined`。
 *  2. **错误信封只有一种形状**（`{ error: ApiError }`）。把 `code` 抠出来交给页面，
 *     页面才能把 `BLOCKED_*` 映射成 `pages-and-flows.md` 的原文，而不是弹一个 `"fetch failed"`。
 *  3. **`fetch` 可注入**：这样才能在 Node 里单测「404 怎么处理」「非 JSON 响应怎么处理」，
 *     不用起浏览器。
 */
import type { ApiError, ErrorCode } from '@eval-platform/contracts';
import { z } from 'zod';

/** 一次失败的业务语义。页面据此决定展示哪段原文。 */
export class ApiClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string;

  constructor(init: { code: ErrorCode; message: string; status: number; requestId: string }) {
    super(init.message);
    this.name = 'ApiClientError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
  }
}

/** 只用于把「失败信封」解析成一个普通对象，不参与业务校验。 */
const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export interface ClientOptions {
  /** 注入点：默认 `globalThis.fetch`。测试里换成假实现。 */
  readonly fetchImpl?: typeof fetch;
  /** 服务端渲染时需要绝对地址；浏览器里留空即可。 */
  readonly baseUrl?: string;
}

async function readEnvelope(res: Response, fallbackCode: ErrorCode): Promise<ApiClientError> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    // 读 body 本身失败（连接中断）—— 用状态码兜底，不要抛出第二个异常
  }

  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    parsed = null;
  }

  const envelope = ErrorEnvelope.safeParse(parsed);
  if (envelope.success) {
    return new ApiClientError({
      code: envelope.data.error.code as ErrorCode,
      message: envelope.data.error.message,
      status: res.status,
      requestId: envelope.data.error.requestId,
    });
  }

  // 非契约响应（网关 502 的 HTML、反代超时页）—— 原文不能直接塞进界面
  return new ApiClientError({
    code: fallbackCode,
    message: `请求失败（HTTP ${String(res.status)}）`,
    status: res.status,
    requestId: '',
  });
}

/**
 * 发一次请求并把响应过一遍契约。三个公开方法的**唯一**实现。
 *
 * 抽成一个内部函数而不是让 `apiGet`/`apiPost`/`apiPatch` 各抄一遍：
 * 「失败分三类」的处理逻辑一旦有一份写漏了（比如 POST 忘了校验形状），
 * 那条路径就会静默渲染 `undefined`，而且没有任何测试会红。
 */
async function send<T extends z.ZodTypeAny>(
  schema: T,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: ClientOptions,
  body: unknown,
): Promise<z.output<T>> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const url = `${options.baseUrl ?? ''}${path}`;

  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, headers };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch {
    throw new ApiClientError({
      code: 'GATEWAY_UNAVAILABLE',
      message: '无法连接服务端',
      status: 0,
      requestId: '',
    });
  }

  if (!res.ok) throw await readEnvelope(res, 'INTERNAL_ERROR');

  let payload: unknown;
  try {
    payload = (await res.json()) as unknown;
  } catch {
    throw new ApiClientError({
      code: 'INTERNAL_ERROR',
      message: '服务端返回的不是合法 JSON',
      status: res.status,
      requestId: '',
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ApiClientError({
      code: 'INTERNAL_ERROR',
      message: `响应不符合契约：${first?.path.join('.') ?? '?'} ${first?.message ?? ''}`.trim(),
      status: res.status,
      requestId: '',
    });
  }
  return parsed.data as z.output<T>;
}

/**
 * `GET path` 并过一遍契约。
 *
 * 失败分三类，处理方式不同：
 *  - HTTP 非 2xx ⇒ 解析错误信封，抛 `ApiClientError`（带业务 `code`）；
 *  - 2xx 但 JSON 不合法 ⇒ `INTERNAL_ERROR`（这是服务端的锅，不该让页面去猜）；
 *  - 2xx 但形状不符契约 ⇒ `INTERNAL_ERROR`，并把 Zod 的 issue 打进 message，
 *    方便开发期一眼看出是哪个字段漂移了。
 */
export async function apiGet<T extends z.ZodTypeAny>(
  schema: T,
  path: string,
  options: ClientOptions = {},
): Promise<z.output<T>> {
  return send(schema, 'GET', path, options, undefined);
}

/** `POST path` + JSON body，同样过契约。 */
export async function apiPost<T extends z.ZodTypeAny>(
  schema: T,
  path: string,
  body: unknown,
  options: ClientOptions = {},
): Promise<z.output<T>> {
  return send(schema, 'POST', path, options, body);
}

/**
 * `PATCH path` + JSON body，同样过契约。
 *
 * 为什么要单独一个而不是让调用方 `fetch` 手写：
 * `PATCH /api/targets/{id}` 是 `PG-06` 唯一会**推版本号**的写操作
 * （「保存后将生成 v2，历史运行仍引用 v1」）。它的响应体是 `Target`，
 * 与列表同一个契约——手写 fetch 就等于放弃这次校验。
 */
export async function apiPatch<T extends z.ZodTypeAny>(
  schema: T,
  path: string,
  body: unknown,
  options: ClientOptions = {},
): Promise<z.output<T>> {
  return send(schema, 'PATCH', path, options, body);
}

/** 把 `ApiClientError` 还原成契约里的 `ApiError` 形状（供 React state 使用）。 */
export function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiClientError) {
    return { code: err.code, message: err.message, requestId: err.requestId };
  }
  return null;
}
