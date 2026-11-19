/**
 * GitHub App 鉴权（M5 Batch 3，Q1 裁定方案 A；Q0 修订后的受控持有形态）。
 *
 * ## 三层结构
 *
 *  1. `signAppJwt`：RS256 三段式 JWT——claims `{iat(-60s), exp(+9min), iss: appId}`，
 *     私钥为集成表里的 PEM（`decryptProviderKey` 还原，`v1:` 密文）；
 *  2. Token 缓存：`Map<appId:installationId, {token, expiresAt}>`——Installation
 *     Token 约 1h 过期，**60s 提前量**换取边界安全；第二次回传不再请求换取端点
 *     （防 Rate Limit，需求方 Batch 3 指令）；
 *  3. `githubApiBase()`：**每次调用现读** `GITHUB_API_BASE_URL`——测试与联调用
 *     本地 Mock（过夜铁律 3：零真实外网），默认 https://api.github.com。
 *
 * ## 浮空 Promise 纪律（需求方 2026-11-19 批准的约束）
 *
 * 本文件的函数全部 `async` 且由调用方 **await 后才响应**——绝不允许
 * 「响应先发、GitHub 调用后到」的竞态（M5 Batch 2 的 insertDelivery 教训）。
 */
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { decryptProviderKey } from '../../db/provider-key-cipher.js';

const GITHUB_API_DEFAULT = 'https://api.github.com';

/** Installation Token 缓存条目：到期前 60s 视为失效（边界安全）。 */
interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** 测试隔离用：清空 Token 缓存（仅测试导入）。 */
export function resetGithubTokenCacheForTests(): void {
  tokenCache.clear();
}

export function githubApiBase(): string {
  return process.env['GITHUB_API_BASE_URL'] ?? GITHUB_API_DEFAULT;
}

/** 平台侧 run 详情页地址（Commit Status 的 target_url）。 */
export function appRunBaseUrl(): string {
  return process.env['APP_BASE_URL'] ?? 'http://127.0.0.1:3000';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** RS256 签发 GitHub App JWT（`iss = appId`，有效期 9 分钟——GitHub 上限 10 分钟）。 */
export function signAppJwt(input: { readonly appId: string; readonly privateKeyPem: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: input.appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(input.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * JWT 换 Installation Token（带内存缓存）。
 *
 * **私钥明文的唯一出口**：`decryptProviderKey` 还原 → 签名 JWT → POST
 * `/app/installations/{id}/access_tokens`。换取失败抛错，由调用方留痕并吞掉
 * （回传失败不阻塞主流程，但**必须落账**——Batch 3 纪律）。
 */
export async function getInstallationToken(input: {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyCiphertext: string;
}): Promise<string> {
  const cacheKey = `${input.appId}:${input.installationId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const privateKeyPem = decryptProviderKey(input.privateKeyCiphertext);
  const jwt = signAppJwt({ appId: input.appId, privateKeyPem });
  const res = await fetch(
    `${githubApiBase()}/app/installations/${input.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) {
    throw new Error(`Installation Token 换取失败：HTTP ${String(res.status)}`);
  }
  const body = (await res.json()) as { token: string; expires_at?: string };
  const expiresAt =
    body.expires_at !== undefined ? new Date(body.expires_at).getTime() : Date.now() + 3_600_000;
  tokenCache.set(cacheKey, { token: body.token, expiresAt });
  return body.token;
}

/**
 * HMAC 也在本文件出口（webhook 验签与回传同源于一个 GitHub 集成语义）——
 * 仅为测试探测便利保留；生产验签走 `services/githubWebhook.ts` 内联实现。
 */
export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Node 内建 RSA 生成（测试用：真实 RS256 签名/验签对）。 */
export function generateRsaPemPair(): { privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
