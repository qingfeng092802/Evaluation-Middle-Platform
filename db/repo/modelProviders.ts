/**
 * 仓储 · `model_providers`。
 *
 * 安全红线：本文件**不**提供「按 id 取整行」的便捷函数给路由用。
 * 读取只能走 `listProviderViews`（刻意不 select `api_key_ciphertext`），
 * 这样「忘记脱敏」在类型层面就不可能发生（`工程规则.md` §9）。
 */
import type { ModelProvider } from '@eval-platform/contracts';
import { decryptProviderKey } from '../provider-key-cipher.js';
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
 *
 * 返回的是**可用的明文**：列里存的是 `db/provider-key-cipher.ts` 的编码串，
 * 这里还原成 Bearer 里该出现的东西。忘了这一步的症状是上游一律 401，
 * 且日志里看不出「我们发的是密文」——所以还原点紧贴读取点，不做二次转发。
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
    apiKey: decryptProviderKey(row.api_key_ciphertext),
    maxConcurrency: row.max_concurrency,
  };
}

/**
 * 新增厂商（`PG-09` 写路径）。
 *
 * 传进来的 `apiKeyCiphertext` 必须**已经过编码**（`db/provider-key-cipher.ts`），
 * 本函数不做编码也不做校验 —— 仓储不知道口令从哪来，也不该知道。
 * 返回值走 `VIEW_COLUMNS`，因此明文 Key 物理上回不到调用方。
 *
 * 唯名冲突由数据库 `ux_model_providers_name` 抛 23505，`lib/api/http.ts` 翻成 409。
 */
export async function createProvider(p: {
  name: string;
  kind: string;
  baseUrl: string | null;
  apiKeyCiphertext: string;
  apiKeyMasked: string;
  maxConcurrency: number;
}): Promise<ModelProvider> {
  const row = await queryOne<ProviderViewRow>(
    `INSERT INTO model_providers
       (name, kind, base_url, api_key_ciphertext, api_key_masked, max_concurrency)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${VIEW_COLUMNS}`,
    [p.name, p.kind, p.baseUrl, p.apiKeyCiphertext, p.apiKeyMasked, p.maxConcurrency],
  );
  if (!row) throw new Error('createProvider 未返回行');
  return toView(row);
}

/** 更新厂商的入参。字段为 `undefined` ⇒ 该列不动（不是置空）。 */
export interface ProviderPatch {
  readonly name?: string | undefined;
  readonly baseUrl?: string | null | undefined;
  /** 已经过编码的密文；`undefined` ⇒ 保留原值。 */
  readonly apiKeyCiphertext?: string | undefined;
  readonly apiKeyMasked?: string | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly isActive?: boolean | undefined;
}

/**
 * 更新厂商；不存在返回 `null`（路由据此 404）。
 *
 * ## 为什么用「只拼出现过的列」而不是 `COALESCE($n, col)`
 *
 * `base_url` 是**可置空**的（`ModelProviderUpdate.baseUrl` 是 `.nullable()`），
 * `COALESCE` 无法区分「没传」与「传了 null」——两者都会保留旧值，
 * 于是「清空 baseUrl」这件事在同一条路径上永远做不到。
 * 动态 `SET` 能精确表达三种状态：不出现 / 出现且为值 / 出现且为 null。
 *
 * `apiKey` 的「省略即保留」也落在这里：`apiKeyCiphertext` 为 `undefined` 时
 * 那一列根本不进 `SET`，而不是写 `NULL`（后者会让配好的厂商在「只改并发」时静默失效）。
 */
export async function updateProvider(id: string, patch: ProviderPatch): Promise<ModelProvider | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  const put = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${String(params.length)}`);
  };

  if (patch.name !== undefined) put('name', patch.name);
  if (patch.baseUrl !== undefined) put('base_url', patch.baseUrl);
  if (patch.apiKeyCiphertext !== undefined) put('api_key_ciphertext', patch.apiKeyCiphertext);
  if (patch.apiKeyMasked !== undefined) put('api_key_masked', patch.apiKeyMasked);
  if (patch.maxConcurrency !== undefined) put('max_concurrency', patch.maxConcurrency);
  if (patch.isActive !== undefined) put('is_active', patch.isActive);

  // 没有任何可改字段：不写库，直接回当前视图（HTTP 语义上仍是一次成功的 PATCH）。
  if (sets.length === 0) return getProviderView(id);

  // `updated_at` 没有数据库触发器，只能在这里显式带上。
  sets.push('updated_at = now()');

  params.push(id);
  const row = await queryOne<ProviderViewRow>(
    `UPDATE model_providers SET ${sets.join(', ')} WHERE id = $${String(params.length)}
     RETURNING ${VIEW_COLUMNS}`,
    params,
  );
  return row ? toView(row) : null;
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
