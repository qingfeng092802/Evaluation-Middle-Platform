/**
 * 仓储 · `targets` / `target_versions`。
 *
 * 版本语义（PG-06）：`config` 变化才产生新版本号；名称变化只改容器。
 * 因此 `updateTarget` 需要先读出当前最新版本的配置做**深比较**，
 * 相同则只改名称 —— 否则每次点「保存」都会把版本号推出 v9、v10，
 * 历史 run 的 v1/v2 引用就再也对不上了。
 *
 * `target_versions` 不可变：本文件不提供任何 UPDATE。
 */
import type { Target, TargetVersion } from '@eval-platform/contracts';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../canonical.js';
import { iso, num, query, queryOne, withTransaction } from './_client.js';

interface TargetRow {
  id: string;
  name: string;
  kind: string;
  current_version_no: number;
  created_at: Date;
  updated_at: Date;
}

function toTargetBase(r: TargetRow): Omit<Target, 'currentVersion'> {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as Target['kind'],
    currentVersionNo: r.current_version_no,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

interface TargetVersionRow {
  id: string;
  target_id: string;
  version_no: number;
  kind: string;
  model_provider_id: string | null;
  model_id: string | null;
  prompt_template: string | null;
  temperature: string | null;
  max_tokens: number | null;
  params: unknown;
  endpoint_url: string | null;
  auth_header_ciphertext: string | null;
  request_mapping: unknown;
  response_mapping: unknown;
  created_by: string;
  created_at: Date;
}

const TV_COLUMNS = `id, target_id, version_no, kind, model_provider_id, model_id,
  prompt_template, temperature, max_tokens, params,
  endpoint_url, auth_header_ciphertext, request_mapping, response_mapping,
  created_by, created_at`;

/** 转成**读取侧**契约（T2 的 `authHeader` 被脱敏成 `hasAuthHeader`）。 */
function toVersionView(r: TargetVersionRow): TargetVersion {
  if (r.kind === 't1_prompt') {
    return {
      id: r.id,
      targetId: r.target_id,
      versionNo: r.version_no,
      config: {
        kind: 't1_prompt',
        modelProviderId: r.model_provider_id as string,
        modelId: r.model_id as string,
        promptTemplate: r.prompt_template as string,
        temperature: num(r.temperature),
        maxTokens: r.max_tokens as number,
        ...(r.params ? { params: r.params as Record<string, unknown> } : {}),
      },
      createdBy: r.created_by,
      createdAt: iso(r.created_at),
    };
  }
  return {
    id: r.id,
    targetId: r.target_id,
    versionNo: r.version_no,
    config: {
      kind: 't2_http',
      endpointUrl: r.endpoint_url as string,
      requestMapping: (r.request_mapping ?? {}) as Record<string, string>,
      responseMapping: (r.response_mapping ?? {}) as Record<string, string>,
      hasAuthHeader: r.auth_header_ciphertext !== null,
    },
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
  };
}

export async function listTargets(limit: number): Promise<Target[]> {
  const rows = await query<TargetRow>(
    `SELECT id, name, kind, current_version_no, created_at, updated_at
       FROM targets ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  const out: Target[] = [];
  for (const r of rows) {
    out.push({
      ...toTargetBase(r),
      currentVersion:
        r.current_version_no > 0
          ? await getVersionByNo(r.id, r.current_version_no)
          : null,
    });
  }
  return out;
}

export async function getTarget(id: string): Promise<Target | null> {
  const r = await queryOne<TargetRow>(
    `SELECT id, name, kind, current_version_no, created_at, updated_at
       FROM targets WHERE id = $1`,
    [id],
  );
  if (!r) return null;
  return {
    ...toTargetBase(r),
    currentVersion:
      r.current_version_no > 0 ? await getVersionByNo(r.id, r.current_version_no) : null,
  };
}

export async function listVersions(targetId: string): Promise<TargetVersion[]> {
  const rows = await query<TargetVersionRow>(
    `SELECT ${TV_COLUMNS} FROM target_versions WHERE target_id = $1 ORDER BY version_no DESC`,
    [targetId],
  );
  return rows.map(toVersionView);
}

export async function getVersionByNo(
  targetId: string,
  versionNo: number,
): Promise<TargetVersion | null> {
  const row = await queryOne<TargetVersionRow>(
    `SELECT ${TV_COLUMNS} FROM target_versions WHERE target_id = $1 AND version_no = $2`,
    [targetId, versionNo],
  );
  return row ? toVersionView(row) : null;
}

export async function getVersionById(versionId: string): Promise<TargetVersion | null> {
  const row = await queryOne<TargetVersionRow>(
    `SELECT ${TV_COLUMNS} FROM target_versions WHERE id = $1`,
    [versionId],
  );
  return row ? toVersionView(row) : null;
}

/**
 * worker 执行时需要的**完整** T1 配置（含 `modelProviderId` 等，无敏感字段）。
 * 与 `TargetVersion` 的区别：不含 `hasAuthHeader` 之类的展示位，直接用即可。
 */
export async function getT1ExecutionConfig(versionId: string): Promise<{
  id: string;
  targetId: string;
  modelProviderId: string;
  modelId: string;
  promptTemplate: string;
  temperature: number;
  maxTokens: number;
  params: Record<string, unknown> | null;
} | null> {
  const row = await queryOne<TargetVersionRow>(
    `SELECT ${TV_COLUMNS} FROM target_versions WHERE id = $1 AND kind = 't1_prompt'`,
    [versionId],
  );
  if (!row || !row.model_provider_id || !row.model_id || !row.prompt_template) return null;
  return {
    id: row.id,
    targetId: row.target_id,
    modelProviderId: row.model_provider_id,
    modelId: row.model_id,
    promptTemplate: row.prompt_template,
    temperature: num(row.temperature),
    maxTokens: row.max_tokens as number,
    params: (row.params as Record<string, unknown> | null) ?? null,
  };
}

type WritableConfig =
  | {
      kind: 't1_prompt';
      modelProviderId: string;
      modelId: string;
      promptTemplate: string;
      temperature: number;
      maxTokens: number;
      /** `exactOptionalPropertyTypes` 下 Zod 的 `.optional()` 推出 `T | undefined`，这里对齐。 */
      params?: Record<string, unknown> | undefined;
    }
  | {
      kind: 't2_http';
      endpointUrl: string;
      authHeader?: string | undefined;
      requestMapping: Record<string, string>;
      responseMapping: Record<string, string>;
    };

async function insertVersion(
  client: PoolClient,
  targetId: string,
  versionNo: number,
  cfg: WritableConfig,
  createdBy: string,
): Promise<void> {
  if (cfg.kind === 't1_prompt') {
    await client.query(
      `INSERT INTO target_versions
         (target_id, version_no, kind, model_provider_id, model_id, prompt_template,
          temperature, max_tokens, params, created_by)
       VALUES ($1, $2, 't1_prompt', $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        targetId,
        versionNo,
        cfg.modelProviderId,
        cfg.modelId,
        cfg.promptTemplate,
        String(cfg.temperature),
        cfg.maxTokens,
        cfg.params ? JSON.stringify(cfg.params) : null,
        createdBy,
      ],
    );
    return;
  }
  await client.query(
    `INSERT INTO target_versions
       (target_id, version_no, kind, endpoint_url, auth_header_ciphertext,
        request_mapping, response_mapping, created_by)
     VALUES ($1, $2, 't2_http', $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      targetId,
      versionNo,
      cfg.endpointUrl,
      // 只写不读：存密文列（M1 未启用 T2，实际不会走到这里）
      cfg.authHeader ?? null,
      JSON.stringify(cfg.requestMapping),
      JSON.stringify(cfg.responseMapping),
      createdBy,
    ],
  );
}

/** 创建 Target = 同时创建 v1（不存在「无版本的 Target」）。 */
export async function createTarget(p: {
  name: string;
  config: WritableConfig;
  createdBy: string;
}): Promise<Target> {
  const id = await withTransaction(async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO targets (name, kind, current_version_no, owner_id)
       VALUES ($1, $2, 1, $3) RETURNING id`,
      [p.name, p.config.kind, p.createdBy],
    );
    const targetId = row.rows[0]?.id;
    if (!targetId) throw new Error('createTarget 未返回 id');
    await insertVersion(client, targetId, 1, p.config, p.createdBy);
    return targetId;
  });
  const created = await getTarget(id);
  if (!created) throw new Error('createTarget 后读取失败');
  return created;
}

export type UpdateTargetResult =
  | { kind: 'updated'; target: Target; newVersionNo: number | null }
  | { kind: 'not_found' };

/**
 * 更新 Target。
 *
 * `config` 与当前最新版本的配置**规范化 JSON 相等** ⇒ 只改名称、不推版本号。
 * 否则追加新版本并把 `current_version_no` 推上去。历史版本一律不动。
 */
export async function updateTarget(p: {
  id: string;
  name?: string | undefined;
  config?: WritableConfig | undefined;
  updatedBy: string;
}): Promise<UpdateTargetResult> {
  return withTransaction(async (client) => {
    const cur = await client.query<TargetRow>(
      `SELECT id, name, kind, current_version_no, created_at, updated_at
         FROM targets WHERE id = $1 FOR UPDATE`,
      [p.id],
    );
    const targetRow = cur.rows[0];
    if (!targetRow) return { kind: 'not_found' as const };

    let newVersionNo: number | null = null;

    if (p.config) {
      const latest = await client.query<TargetVersionRow>(
        `SELECT ${TV_COLUMNS} FROM target_versions
          WHERE target_id = $1 ORDER BY version_no DESC LIMIT 1`,
        [p.id],
      );
      const latestRow = latest.rows[0];
      const changed =
        !latestRow || canonicalJson(toComparable(latestRow)) !== canonicalJson(p.config);

      if (changed) {
        const nextNo = targetRow.current_version_no + 1;
        await insertVersion(client, p.id, nextNo, p.config, p.updatedBy);
        await client.query(
          `UPDATE targets SET kind = $2, current_version_no = $3, updated_at = now() WHERE id = $1`,
          [p.id, p.config.kind, nextNo],
        );
        newVersionNo = nextNo;
      }
    }

    if (p.name !== undefined) {
      await client.query(
        `UPDATE targets SET name = $2, updated_at = now() WHERE id = $1`,
        [p.id, p.name],
      );
    }

    const fresh = await getTarget(p.id);
    if (!fresh) throw new Error('updateTarget 后读取失败');
    return { kind: 'updated' as const, target: fresh, newVersionNo };
  });
}

/** 把版本行整理成与写入侧 `WritableConfig` 同构的可比较对象（T2 的 authHeader 不参与比较）。 */
function toComparable(r: TargetVersionRow): WritableConfig {
  if (r.kind === 't1_prompt') {
    return {
      kind: 't1_prompt',
      modelProviderId: r.model_provider_id ?? '',
      modelId: r.model_id ?? '',
      promptTemplate: r.prompt_template ?? '',
      temperature: num(r.temperature),
      maxTokens: r.max_tokens ?? 0,
      ...(r.params ? { params: r.params as Record<string, unknown> } : {}),
    };
  }
  return {
    kind: 't2_http',
    endpointUrl: r.endpoint_url ?? '',
    requestMapping: (r.request_mapping ?? {}) as Record<string, string>,
    responseMapping: (r.response_mapping ?? {}) as Record<string, string>,
  };
}
