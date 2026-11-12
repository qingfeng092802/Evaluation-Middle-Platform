/**
 * 厂商连通性探针（`POST /api/providers/{providerId}/probe`，`US-015` / `PG-09`）。
 *
 * ## 安全口径（本文件最要紧的部分）
 *
 * 探针的用途是「通不通」，因此：
 *  - **响应里没有任何 Key 片段**，连 `apiKeyMasked` 都不回（多一处就多一个泄露面）；
 *  - 请求里的 `apiKeyOverride` 是明文，**只用一次，不落库、不回显、不写日志**；
 *  - 错误信息只保留**上游原话的截断**，绝不拼接本地路径、栈信息或凭据。
 *
 * ## 为什么分类要分这么细
 *
 * 「连不上」和「连上了但 Key 不对」对用户是两条完全不同的处置路径：
 * 前者查网络 / baseUrl，后者查 Key。合成一个 `FAILED` 会让人在两个方向上乱试。
 * 因此按 `ModelProviderProbeStatus` 的五个档位逐一区分。
 *
 * ## 为什么不复用 `lib/gateway`
 *
 * `chatComplete` 带**指数退避重试**（最多 3 次，合计 ~3.5s）。对跑批那是对的，
 * 对「测一下通不通」是错的：用户点一次按钮要等 3.5 秒才知道连不上，
 * 而且重试会让 `latencyMs` 失去「单次往返耗时」的含义。探针刻意自己发一次请求。
 */
import type {
  ModelPrice,
  ModelProvider,
  ModelProviderCreate,
  ModelProviderProbeRequest,
  ModelProviderProbeResult,
  ModelProviderProbeStatus,
  ModelProviderUpdate,
} from '@eval-platform/contracts';
import {
  ModelProviderCreate as ModelProviderCreateSchema,
  ModelProviderUpdate as ModelProviderUpdateSchema,
  ModelPriceCreate,
} from '@eval-platform/contracts';
import {
  createPrice as repoCreatePrice,
  listPricesByProvider,
} from '../../../db/repo/modelPrices.js';
import {
  createProvider as repoCreateProvider,
  getProviderForExecution,
  getProviderView,
  listProviderViews,
  updateProvider as repoUpdateProvider,
} from '../../../db/repo/modelProviders.js';
import { encryptProviderKey, maskProviderKey } from '../../../db/provider-key-cipher.js';
import { NotFoundError } from '../../api/http.js';

/** 全部厂商（可回传视图，绝不含 `apiKeyCiphertext`）。 */
export async function listProviders(): Promise<ModelProvider[]> {
  return listProviderViews();
}

// ---------------------------------------------------------------------------
// 写路径（`PG-09`「模型网关」Tab）
// ---------------------------------------------------------------------------

/**
 * 新增厂商。
 *
 * 明文 `apiKey` 在本函数里走完「掩码 → 加密 → 丢弃」三步，此后**不再出现**：
 * 返回值来自仓储的视图列，类型上就不含它。
 * 这里刻意不 `console` 入参，也不把它塞进任何异常消息（`工程规则` §9）。
 */
export async function createProvider(raw: unknown): Promise<ModelProvider> {
  const body: ModelProviderCreate = ModelProviderCreateSchema.parse(raw);

  // base_url 列可空；契约里 baseUrl 是「可选」，缺省即「官方直连」。
  const baseUrl = body.baseUrl ?? null;

  return repoCreateProvider({
    name: body.name,
    kind: body.kind,
    baseUrl,
    apiKeyCiphertext: encryptProviderKey(body.apiKey),
    apiKeyMasked: maskProviderKey(body.apiKey),
    maxConcurrency: body.maxConcurrency,
  });
}

/**
 * 更新厂商。
 *
 * **`apiKey` 省略 ⇒ 密文列不进 `SET`**（见仓储 `updateProvider` 的注释）。
 * 这条是「只改并发上限不该让厂商静默失效」的唯一实现点：一旦这里把
 * `apiKeyCiphertext` 传成 `null` 或空串，密钥就没了，而响应里只有掩码，用户看不出来。
 */
export async function updateProvider(providerId: string, raw: unknown): Promise<ModelProvider> {
  const body: ModelProviderUpdate = ModelProviderUpdateSchema.parse(raw);

  const updated = await repoUpdateProvider(providerId, {
    name: body.name,
    baseUrl: body.baseUrl,
    ...(body.apiKey === undefined
      ? {}
      : {
          apiKeyCiphertext: encryptProviderKey(body.apiKey),
          apiKeyMasked: maskProviderKey(body.apiKey),
        }),
    maxConcurrency: body.maxConcurrency,
    isActive: body.isActive,
  });

  if (updated === null) throw new NotFoundError('厂商不存在');
  return updated;
}

/** 新增单价（只增行、不改行，见仓储注释）。 */
export async function createPrice(raw: unknown): Promise<ModelPrice> {
  const body = ModelPriceCreate.parse(raw);

  // 先查厂商是否存在：外键违规（23503）会落到 500，
  // 而「给不存在的厂商报价」是纯业务错误，应当是 404。
  const provider = await getProviderView(body.modelProviderId);
  if (!provider) throw new NotFoundError('厂商不存在');

  return repoCreatePrice({
    modelProviderId: body.modelProviderId,
    modelId: body.modelId,
    displayName: body.displayName,
    inputPricePer1k: body.inputPricePer1k,
    outputPricePer1k: body.outputPricePer1k,
    currency: body.currency,
    effectiveFrom: body.effectiveFrom,
  });
}

/** 单价列表；`providerId` 省略 ⇒ 全部。 */
export async function listPricePage(providerId?: string): Promise<ModelPrice[]> {
  return listPricesByProvider(providerId);
}

/** 探针单次请求超时：比跑批短，因为它只是「测一下」。 */
const PROBE_TIMEOUT_MS = 8_000;

/** 错误信息截断长度（契约 `errorMessage` 的 max 是 500）。 */
const MAX_ERROR_CHARS = 500;

interface ProbeTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * 组装这次探针要用的连接信息。
 *
 * 优先级：请求里的 override > 库里已存的。
 * 后者需要读密文，所以走 `getProviderForExecution` —— 这是唯一读密文的函数。
 */
async function resolveTarget(
  providerId: string,
  body: ModelProviderProbeRequest,
): Promise<ProbeTarget> {
  const view = await getProviderView(providerId);
  if (!view) throw new NotFoundError('厂商不存在');

  let apiKey: string | undefined = body.apiKeyOverride;
  if (apiKey === undefined) {
    const exec = await getProviderForExecution(providerId);
    if (!exec) {
      // 厂商存在但不可执行（无 base_url 或已停用）⇒ 明确告诉用户缺什么，
      // 而不是发一个必然失败的请求然后报「不可达」。
      const reason = view.isActive ? '尚未配置 baseUrl' : '该厂商已停用';
      return Promise.reject(new NotFoundError(`无法探测：${reason}`));
    }
    apiKey = exec.apiKey;
  }

  const baseUrl = body.baseUrlOverride ?? view.baseUrl;
  if (baseUrl === null || baseUrl === '') {
    return Promise.reject(new NotFoundError('无法探测：尚未配置 baseUrl'));
  }

  return { baseUrl, apiKey };
}

/** 把上游错误体截断成可展示的一句话。只取上游原话，不拼本地信息。 */
function truncateError(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '（上游无错误详情）';
  return oneLine.length > MAX_ERROR_CHARS ? `${oneLine.slice(0, MAX_ERROR_CHARS)}…` : oneLine;
}

function result(
  status: ModelProviderProbeStatus,
  latencyMs: number | null,
  errorMessage: string | null,
): ModelProviderProbeResult {
  return {
    status,
    latencyMs,
    errorMessage,
    probedAt: new Date().toISOString(),
  };
}

/**
 * 执行一次探针。
 *
 * 判定顺序（先网络、再鉴权、再响应形状）：
 *  1. `fetch` 抛错 ⇒ `UNREACHABLE`（DNS / 拒连 / 超时，`latencyMs = null`）
 *  2. 401 / 403 ⇒ `UNAUTHORIZED`
 *  3. 5xx ⇒ `UPSTREAM_ERROR`
 *  4. 其它非 2xx ⇒ `BAD_RESPONSE`
 *  5. 2xx 但响应不是 OpenAI 兼容形状 ⇒ `BAD_RESPONSE`
 *  6. 否则 ⇒ `OK`
 */
export async function probeProvider(
  providerId: string,
  body: ModelProviderProbeRequest,
): Promise<ModelProviderProbeResult> {
  const target = await resolveTarget(providerId, body);

  // 给了 modelId 就测一次最小 chat 调用（部分厂商 /models 与 chat 的鉴权口径不同）；
  // 没给就只测 GET /models 可达性。
  const useChat = body.modelId !== undefined;
  const url = useChat
    ? `${target.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    : `${target.baseUrl.replace(/\/+$/, '')}/v1/models`;

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: useChat ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        ...(useChat ? { 'content-type': 'application/json' } : {}),
      },
      ...(useChat
        ? {
            body: JSON.stringify({
              model: body.modelId,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
            }),
          }
        : {}),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    return result(
      'UNREACHABLE',
      null,
      isTimeout ? `连接超时（${String(PROBE_TIMEOUT_MS)}ms）` : truncateError((err as Error).message),
    );
  }

  const latencyMs = Date.now() - startedAt;

  if (res.status === 401 || res.status === 403) {
    const text = await res.text().catch(() => '');
    return result('UNAUTHORIZED', latencyMs, truncateError(text || `上游返回 ${String(res.status)}`));
  }

  if (res.status >= 500) {
    const text = await res.text().catch(() => '');
    return result(
      'UPSTREAM_ERROR',
      latencyMs,
      truncateError(text || `上游返回 ${String(res.status)}`),
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return result('BAD_RESPONSE', latencyMs, truncateError(text || `上游返回 ${String(res.status)}`));
  }

  // 2xx：校验响应形状是否是 OpenAI 兼容的那一种。
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return result('BAD_RESPONSE', latencyMs, '响应不是合法 JSON');
  }

  const shaped = useChat
    ? Array.isArray((json as { choices?: unknown }).choices)
    : Array.isArray((json as { data?: unknown }).data);

  if (!shaped) {
    return result(
      'BAD_RESPONSE',
      latencyMs,
      useChat ? '响应缺少 choices 数组' : '响应缺少 data 数组',
    );
  }

  return result('OK', latencyMs, null);
}
