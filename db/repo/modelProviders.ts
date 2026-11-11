/**
 * 仓储 · `model_providers`。
 *
 * 安全红线：本文件**不**提供「按 id 取整行」的便捷函数给路由用。
 * 读取只能走 `listProviderViews`（刻意不 select `api_key_ciphertext`），
 * 这样「忘记脱敏」在类型层面就不可能发生（`工程规则.md` §9）。
 */
import type { ModelProvider } from '@eval-platform/contracts';
import { iso, query, queryOne } from './_client.js';

/** 只含可回传列的行（无密文）。 */
interface ProviderViewRow {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  api_key_masked: string;
  max_concurrency: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const VIEW_COLUMNS = `id, name, kind, base_url, api_key_masked, max_concurrency, is_active, created_at, updated_at`;

function toView(r: ProviderViewRow): ModelProvider {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ModelProvider['kind'],
    baseUrl: r.base_url,
    apiKeyMasked: r.api_key_masked,
    maxConcurrency: r.max_concurrency,
    isActive: r.is_active,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** 全部厂商（可回传视图）。 */
export async function listProviderViews(): Promise<ModelProvider[]> {
  const rows = await query<ProviderViewRow>(
    `SELECT ${VIEW_COLUMNS} FROM model_providers ORDER BY created_at ASC`,
  );
  return rows.map(toView);
}

/** 单个厂商（可回传视图）；不存在返回 `null`。 */
export async function getProviderView(id: string): Promise<ModelProvider | null> {
  const row = await queryOne<ProviderViewRow>(
    `SELECT ${VIEW_COLUMNS} FROM model_providers WHERE id = $1`,
    [id],
  );
  return row ? toView(row) : null;
}

/** 是否存在任一启用中的厂商（`RunPreflight.hasProviderCredentials` 的唯一依据）。 */
export async function hasActiveProvider(): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM model_providers WHERE is_active = true`,
  );
  return row !== null && Number(row.n) > 0;
}

/**
 * 取「执行时真正要用的」厂商连接信息（含 `base_url`）。
 *
 * 这是**唯一**会读 `api_key_ciphertext` 的函数，仅供 worker 内部构造网关请求头；
 * 返回类型刻意不叫 `ModelProvider`，避免被误当作 API 响应体。
 */
export async function getProviderForExecution(
  id: string,
): Promise<{ id: string; baseUrl: string; apiKey: string; maxConcurrency: number } | null> {
  const row = await queryOne<{
    id: string;
    base_url: string | null;
    api_key_ciphertext: string;
    max_concurrency: number;
  }>(
    `SELECT id, base_url, api_key_ciphertext, max_concurrency
       FROM model_providers WHERE id = $1 AND is_active = true`,
    [id],
  );
  if (!row || !row.base_url) return null;
  return {
    id: row.id,
    baseUrl: row.base_url,
    apiKey: row.api_key_ciphertext,
    maxConcurrency: row.max_concurrency,
  };
}

/** 种子用：按名称幂等写入 fixture provider。 */
export async function upsertFixtureProvider(p: {
  name: string;
  kind: string;
  baseUrl: string;
  apiKeyCiphertext: string;
  apiKeyMasked: string;
  maxConcurrency: number;
  isActive: boolean;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked, max_concurrency, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE
       SET kind = EXCLUDED.kind,
           base_url = EXCLUDED.base_url,
           api_key_masked = EXCLUDED.api_key_masked,
           max_concurrency = EXCLUDED.max_concurrency,
           is_active = EXCLUDED.is_active,
           updated_at = now()
     RETURNING id`,
    [
      p.name,
      p.kind,
      p.baseUrl,
      p.apiKeyCiphertext,
      p.apiKeyMasked,
      p.maxConcurrency,
      p.isActive,
    ],
  );
  if (!row) throw new Error('upsertFixtureProvider 未返回 id');
  return row.id;
}
