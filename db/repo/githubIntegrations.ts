/**
 * GitHub 推入模式仓储（M5 Batch 1/2，`US-022`）。
 *
 * SQL 唯一住所（SPEC-M1 §1.4 分层）。三条数据库铁律由**数据库**当裁判：
 *  - `webhook_deliveries.delivery_id` UNIQUE —— 重放拒绝的物理载体（0022）；
 *  - `webhook_deliveries` 整表不可变（`trg_webhook_deliveries_immutable`）——
 *    处理结果在 INSERT 时一次性定稿，重放只读既有行；
 *  - `github_integrations` 的凭据三列只进不出（读取视图只有布尔位）。
 *
 * 凭据编码复用 `db/provider-key-cipher.ts` 的 `v1:` AES-256-GCM（Q0 修订后的
 * 受控持有形态）；解密仅发生在 Batch 3 的回传调用点（本文件只写不读私钥）。
 */
import type { GithubIntegration, PrTriggerRule } from '@eval-platform/contracts';
import { encryptProviderKey } from '../provider-key-cipher.js';
import { iso, query, queryOne } from './_client.js';

interface IntegrationRow {
  id: string;
  name: string;
  kind: string;
  app_id: string | null;
  installation_id: string | null;
  private_key_ct: string | null;
  pat_ciphertext: string | null;
  webhook_secret: string;
  repos: unknown;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function integrationView(row: IntegrationRow): GithubIntegration {
  return {
    id: row.id,
    name: row.name,
    kind: 'github_app',
    appId: row.app_id ?? '',
    installationId: row.installation_id ?? '',
    hasPrivateKey: row.private_key_ct !== null,
    hasWebhookSecret: row.webhook_secret !== '',
    repos: (row.repos as Array<{ owner: string; repo: string }>) ?? [],
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const INTEGRATION_COLUMNS =
  'id, name, kind, app_id, installation_id, private_key_ct, pat_ciphertext, webhook_secret, repos, is_active, created_at, updated_at';

export interface CreateIntegrationInput {
  readonly name: string;
  readonly appId: string;
  readonly installationId: string;
  /** PEM 明文；本函数内立即加密为密文列，明文不落库。 */
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly repos: ReadonlyArray<{ readonly owner: string; readonly repo: string }>;
  readonly createdBy: string;
}

export async function createIntegration(input: CreateIntegrationInput): Promise<GithubIntegration> {
  const row = await queryOne<IntegrationRow>(
    `INSERT INTO github_integrations
       (name, kind, app_id, installation_id, private_key_ct, webhook_secret, repos, created_by)
     VALUES ($1, 'github_app', $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING ${INTEGRATION_COLUMNS}`,
    [
      input.name,
      input.appId,
      input.installationId,
      encryptProviderKey(input.privateKey),
      input.webhookSecret,
      JSON.stringify(input.repos),
      input.createdBy,
    ],
  );
  if (!row) throw new Error('INSERT … RETURNING 未返回行');
  return integrationView(row);
}

export async function getIntegrationRow(id: string): Promise<GithubIntegration | null> {
  const row = await queryOne<IntegrationRow>(
    `SELECT ${INTEGRATION_COLUMNS} FROM github_integrations WHERE id = $1`,
    [id],
  );
  return row ? integrationView(row) : null;
}

export async function listIntegrationViews(): Promise<GithubIntegration[]> {
  const rows = await query<IntegrationRow>(
    `SELECT ${INTEGRATION_COLUMNS} FROM github_integrations ORDER BY created_at DESC`,
  );
  return rows.map(integrationView);
}

export async function updateIntegration(
  id: string,
  patch: {
    readonly name?: string | undefined;
    readonly installationId?: string | undefined;
    readonly privateKey?: string | undefined;
    readonly webhookSecret?: string | undefined;
    readonly repos?: ReadonlyArray<{ readonly owner: string; readonly repo: string }> | undefined;
    readonly isActive?: boolean | undefined;
  },
): Promise<GithubIntegration | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  const add = (expr: string, value: unknown): void => {
    params.push(value);
    sets.push(expr.replace('$?', `$${String(params.length)}`));
  };
  if (patch.name !== undefined) add('name = $?', patch.name);
  if (patch.installationId !== undefined) add('installation_id = $?', patch.installationId);
  if (patch.privateKey !== undefined) add('private_key_ct = $?', encryptProviderKey(patch.privateKey));
  if (patch.webhookSecret !== undefined) add('webhook_secret = $?', patch.webhookSecret);
  if (patch.repos !== undefined) add('repos = $?::jsonb', JSON.stringify(patch.repos));
  if (patch.isActive !== undefined) add('is_active = $?', patch.isActive);
  params.push(id);
  const row = await queryOne<IntegrationRow>(
    `UPDATE github_integrations SET ${sets.join(', ')} WHERE id = $${String(params.length)}
     RETURNING ${INTEGRATION_COLUMNS}`,
    params,
  );
  return row ? integrationView(row) : null;
}

/** 活跃集成的验签密钥清单（HMAC 常量时间比较逐个尝试；集成数量为个位数，O(n) 可接受）。 */
export async function listActiveWebhookSecrets(): Promise<
  ReadonlyArray<{ readonly id: string; readonly webhookSecret: string }>
> {
  return query<{ id: string; webhook_secret: string }>(
    `SELECT id, webhook_secret FROM github_integrations WHERE is_active = true`,
  ).then((rows) => rows.map((r) => ({ id: r.id, webhookSecret: r.webhook_secret })));
}

// ---------------------------------------------------------------------------
// webhook_deliveries（只追加；重放 = 读既有行返回 DEDUPED）
// ---------------------------------------------------------------------------

export interface DeliveryRow {
  readonly id: string;
  readonly delivery_id: string;
  readonly processed_status: string;
  readonly run_id: string | null;
}

/**
 * 落一行投递账。`ON CONFLICT (delivery_id) DO NOTHING` + RETURNING：
 * 返回 null = 该 delivery 已存在（重放），调用方读既有行返回 DEDUPED。
 */
export async function insertDelivery(input: {
  readonly deliveryId: string;
  readonly integrationId: string;
  readonly event: string;
  readonly signatureVerified: boolean;
  readonly processedStatus: string;
  readonly runId: string | null;
  readonly payloadSummary: unknown;
}): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (delivery_id, integration_id, event, signature_verified, processed_status, run_id, payload_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING id`,
    [
      input.deliveryId,
      input.integrationId,
      input.event,
      input.signatureVerified,
      input.processedStatus,
      input.runId,
      JSON.stringify(input.payloadSummary ?? null),
    ],
  );
  return row?.id ?? null;
}

export async function findDelivery(deliveryId: string): Promise<DeliveryRow | null> {
  return queryOne<DeliveryRow>(
    `SELECT id, delivery_id, processed_status, run_id FROM webhook_deliveries WHERE delivery_id = $1`,
    [deliveryId],
  );
}

/** 投递历史（PG-09「GitHub 集成」区块），按 received_at 倒序。 */
export async function listDeliveries(integrationId: string): Promise<
  ReadonlyArray<{
    readonly id: string;
    readonly deliveryId: string;
    readonly event: string;
    readonly processedStatus: string;
    readonly runId: string | null;
    readonly summary: unknown;
    readonly receivedAt: string;
  }>
> {
  const rows = await query<{
    id: string;
    delivery_id: string;
    event: string;
    processed_status: string;
    run_id: string | null;
    payload_summary: unknown;
    received_at: Date | string;
  }>(
    `SELECT id, delivery_id, event, processed_status, run_id, payload_summary, received_at
       FROM webhook_deliveries
      WHERE integration_id = $1
      ORDER BY received_at DESC, id DESC`,
    [integrationId],
  );
  return rows.map((r) => ({
    id: r.id,
    deliveryId: r.delivery_id,
    event: r.event,
    processedStatus: r.processed_status,
    runId: r.run_id,
    summary: r.payload_summary,
    receivedAt: iso(r.received_at),
  }));
}

// ---------------------------------------------------------------------------
// pr_trigger_rules（Q6：绑定 PR 专用冒烟集）
// ---------------------------------------------------------------------------

function mapRule(row: {
  id: string;
  integration_id: string;
  repo_full_name: string;
  target_branch: string | null;
  path_globs: unknown;
  label: string | null;
  dataset_id: string;
  target_id: string | null;
  enabled: boolean;
  created_at: Date | string;
}): PrTriggerRule {
  return {
    id: row.id,
    integrationId: row.integration_id,
    repoFullName: row.repo_full_name,
    targetBranch: row.target_branch,
    pathGlobs: (row.path_globs as string[] | null) ?? null,
    label: row.label,
    datasetId: row.dataset_id,
    targetId: row.target_id,
    enabled: row.enabled,
    createdAt: iso(row.created_at),
  };
}

const RULE_COLUMNS =
  'id, integration_id, repo_full_name, target_branch, path_globs, label, dataset_id, target_id, enabled, created_at';

export async function createTriggerRule(input: {
  readonly integrationId: string;
  readonly repoFullName: string;
  readonly targetBranch: string | null;
  readonly pathGlobs: ReadonlyArray<string> | null;
  readonly label: string | null;
  readonly datasetId: string;
  readonly targetId: string | null;
  readonly createdBy: string;
}): Promise<PrTriggerRule> {
  const row = await queryOne<Parameters<typeof mapRule>[0]>(
    `INSERT INTO pr_trigger_rules
       (integration_id, repo_full_name, target_branch, path_globs, label, dataset_id, target_id, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING ${RULE_COLUMNS}`,
    [
      input.integrationId,
      input.repoFullName,
      input.targetBranch,
      input.pathGlobs === null ? null : JSON.stringify(input.pathGlobs),
      input.label,
      input.datasetId,
      input.targetId,
      input.createdBy,
    ],
  );
  if (!row) throw new Error('INSERT … RETURNING 未返回行');
  return mapRule(row);
}

/** 某仓库的启用规则（created_at 升序——稳定的多命中触发顺序）。 */
export async function listEnabledTriggerRules(
  repoFullName: string,
): Promise<PrTriggerRule[]> {
  const rows = await query<Parameters<typeof mapRule>[0]>(
    `SELECT ${RULE_COLUMNS} FROM pr_trigger_rules
      WHERE repo_full_name = $1 AND enabled = true
      ORDER BY created_at, id`,
    [repoFullName],
  );
  return rows.map(mapRule);
}

/** 某集成下的全部规则（PG-09 配置面用，含停用行）。 */
export async function listTriggerRulesByIntegration(
  integrationId: string,
): Promise<PrTriggerRule[]> {
  const rows = await query<Parameters<typeof mapRule>[0]>(
    `SELECT ${RULE_COLUMNS} FROM pr_trigger_rules
      WHERE integration_id = $1
      ORDER BY created_at, id`,
    [integrationId],
  );
  return rows.map(mapRule);
}

// ---------------------------------------------------------------------------
// 协作式取消（Q3：synchronize → 旧 RUNNING run 的 cancel_requested）
// ---------------------------------------------------------------------------

/**
 * 某 run 的 GitHub 回传上下文（集成 × 仓库 × head_sha）。
 * 经 webhook_deliveries 账本回链（run_id → TRIGGERED 投递 → 集成 → 凭据）。
 * 集成已停用（is_active=false）则不出站——回传是集成级行为。
 */
export async function findGithubOutboundContextForRun(
  runId: string,
): Promise<
  ReadonlyArray<{
    readonly integrationId: string;
    readonly repoFullName: string;
    readonly headSha: string;
    readonly appId: string;
    readonly installationId: string;
    readonly privateKeyCiphertext: string;
  }>
> {
  const rows = await query<{
    integration_id: string;
    repo_full_name: string;
    head_sha: string;
    app_id: string | null;
    installation_id: string | null;
    private_key_ct: string | null;
  }>(
    `SELECT DISTINCT d.integration_id,
            d.payload_summary->>'repo_full_name' AS repo_full_name,
            d.payload_summary->>'head_sha' AS head_sha,
            i.app_id, i.installation_id, i.private_key_ct
       FROM webhook_deliveries d
       JOIN github_integrations i ON i.id = d.integration_id
      WHERE d.run_id = $1 AND d.processed_status = 'TRIGGERED' AND i.is_active = true`,
    [runId],
  );
  return rows
    .filter((r) => r.repo_full_name !== null && r.head_sha !== null)
    .map((r) => ({
      integrationId: r.integration_id,
      repoFullName: r.repo_full_name!,
      headSha: r.head_sha!,
      appId: r.app_id ?? '',
      installationId: r.installation_id ?? '',
      privateKeyCiphertext: r.private_key_ct ?? '',
    }));
}

/** 同 PR 历史触发的 run（经 deliveries 账本回链：payload_summary 存 repo/pr 号）。 */
export async function listPriorTriggeredRunIds(
  integrationId: string,
  repoFullName: string,
  prNumber: number,
): Promise<string[]> {
  const rows = await query<{ run_id: string }>(
    `SELECT run_id FROM webhook_deliveries
      WHERE integration_id = $1 AND processed_status = 'TRIGGERED' AND run_id IS NOT NULL
        AND payload_summary->>'repo_full_name' = $2
        AND payload_summary->>'pr_number' = $3
      ORDER BY received_at DESC`,
    [integrationId, repoFullName, String(prNumber)],
  );
  return rows.map((r) => r.run_id);
}

/** 只对 **RUNNING** 的 run 置取消请求位（PENDING/终态不动——PENDING 取消走既有合法边，终态冻结）。 */
export async function setCancelRequestedIfRunning(runId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE eval_runs SET cancel_requested = true
      WHERE id = $1 AND status = 'RUNNING'
      RETURNING id`,
    [runId],
  );
  return row !== null;
}
