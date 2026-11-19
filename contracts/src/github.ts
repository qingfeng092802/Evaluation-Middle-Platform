/**
 * M5 推入模式契约 —— GitHub Webhook 集成（需求方 2026-11-19 七项裁定：
 * Q0 红线推翻受控持有 / Q1 方案 A / Q2 只做 GitHub / Q3 中断 / Q4 永不克隆 /
 * Q5 Status 必交付 + 评论顺延半批 / Q6 备选先行不改求值内核）。
 *
 * 事实源：`docs/Spec/SPEC-M5.md` §2.4 / §附录 C；`工程规则.md` §9（修订后）。
 *
 * ## 契约层非对称（承 §9「只写不读」）
 *
 *  - `GithubIntegrationCreate` / `GithubIntegrationUpdate` 携带 `privateKey` /
 *    `webhookSecret` **明文**（仅出现在写入请求）；
 *  - `GithubIntegration`（读取形状）**零凭据**：只有 `hasPrivateKey` /
 *    `hasWebhookSecret` 布尔位——这两键在读取 shape 里**不存在**，zod parse
 *    顺带剥离任何多塞进来的凭据字段（泄密扫描：`tests/github-contract-leak.spec.ts`）。
 *
 * ## 白名单纪律
 *
 * GitHub 的 webhook 全量载荷远大于本平台所需：`PullRequestEvent` 只声明
 * opened / synchronize / closed 三态的最小字段，`parse` 即剥离其余——
 * **全量载荷不落库**（deliveries 只存 `payload_summary` 白名单摘要）。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */
import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';

// ---------------------------------------------------------------------------
// 入站：GitHub Webhook（pull_request 三态白名单）
// ---------------------------------------------------------------------------

/** M5 只消费 `pull_request` 事件的三个动作（opened / synchronize / closed）。 */
export const PullRequestEventAction = z.enum(['opened', 'synchronize', 'closed']);
export type PullRequestEventAction = z.infer<typeof PullRequestEventAction>;

/**
 * Webhook 载荷白名单。GitHub 真实载荷含 `sender` / `installation` / `changes` 等
 * 数十个无关字段——**parse 即剥离**，未知字段不进系统、不落库。
 */
export const PullRequestEvent = z.object({
  action: PullRequestEventAction,
  number: z.number().int().min(1),
  repository: z.object({ full_name: z.string().min(1) }),
  pull_request: z.object({
    head: z.object({ sha: z.string().min(10), ref: z.string() }),
    base: z.object({ ref: z.string() }),
    /** Q6：label 优先于 pathGlobs / targetBranch 的匹配策略需要它。 */
    labels: z.array(z.object({ name: z.string() })).default([]),
    html_url: z.string().url(),
  }),
});
export type PullRequestEvent = z.infer<typeof PullRequestEvent>;

/** Webhook 处理结果状态（响应体与 `webhook_deliveries.processed_status` 共用口径）。 */
export const WebhookProcessStatus = z.enum([
  'TRIGGERED',
  'SKIPPED_CLOSED',
  'SKIPPED_UNBOUND',
  'DEDUPED',
  'REJECTED_SIGNATURE',
  /** 非评测事件（GitHub ping 等）——验真后落账但不触发评测（0024 增补 DB 枚举）。 */
  'SKIPPED_EVENT',
]);
export type WebhookProcessStatus = z.infer<typeof WebhookProcessStatus>;

/** 入站响应统一形状：200（TRIGGERED / SKIPPED_CLOSED / DEDUPED）与 202（SKIPPED_UNBOUND）同构。 */
export const WebhookResponse = z.object({
  status: WebhookProcessStatus,
  deduped: z.boolean(),
  /** Batch 2 为占位触发（无 run）；Batch 3 接真实 run 创建后回填。 */
  runId: Uuid.nullable(),
});
export type WebhookResponse = z.infer<typeof WebhookResponse>;

// ---------------------------------------------------------------------------
// 配置面：集成（只写不读的非对称）
// ---------------------------------------------------------------------------

export const GithubRepoRef = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});
export type GithubRepoRef = z.infer<typeof GithubRepoRef>;

/** 创建集成（Q1 裁定：方案 A；凭据明文**仅出现在本请求体**）。 */
export const GithubIntegrationCreate = z.object({
  name: z.string().min(1).max(120),
  appId: z.string().min(1),
  installationId: z.string().min(1),
  /** PEM 全文（`-----BEGIN` 起始）。明文只在本次请求出现，服务端立即 AES-256-GCM 加密。 */
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1),
  repos: z.array(GithubRepoRef).min(1),
});
export type GithubIntegrationCreate = z.infer<typeof GithubIntegrationCreate>;

/** 更新集成：「不传即不改」；`privateKey` / `webhookSecret` 重传 = 密文覆写（重置语义）。 */
export const GithubIntegrationUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  installationId: z.string().min(1).optional(),
  privateKey: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
  repos: z.array(GithubRepoRef).optional(),
  isActive: z.boolean().optional(),
});
export type GithubIntegrationUpdate = z.infer<typeof GithubIntegrationUpdate>;

/**
 * 读取形状：**零凭据**。`privateKey` / `webhookSecret` 两键在 shape 中不存在——
 * parse 会剥离调用方偷塞的任何凭据字段，只留布尔位。
 * `patCiphertext`（GHES 降级备选列）M5 不实现（Q1），读取形状因此无 pat 相关键。
 */
export const GithubIntegration = z.object({
  id: Uuid,
  name: z.string(),
  /** Q2：M5 锁 `'github_app'`。 */
  kind: z.literal('github_app'),
  appId: z.string(),
  installationId: z.string(),
  hasPrivateKey: z.boolean(),
  hasWebhookSecret: z.boolean(),
  repos: z.array(GithubRepoRef),
  isActive: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GithubIntegration = z.infer<typeof GithubIntegration>;

// ---------------------------------------------------------------------------
// 配置面：PR → 评测集触发规则（Q6：绑定 PR 专用冒烟集）
// ---------------------------------------------------------------------------

/** 至少配置一种匹配策略（label / pathGlobs / targetBranch）——否则规则永不可能命中。 */
export const PrTriggerRuleCreate = z
  .object({
    integrationId: Uuid,
    repoFullName: z.string().min(1),
    /** 策略③：目标分支精确匹配。 */
    targetBranch: z.string().min(1).optional(),
    /** 策略②：变更文件路径 glob——匹配需要 GitHub API files 只读列表（Batch 3，Q4）。 */
    pathGlobs: z.array(z.string().min(1)).optional(),
    /** 策略①：PR Label 精确匹配（优先级最高）。 */
    label: z.string().min(1).optional(),
    datasetId: Uuid,
    targetId: Uuid.nullable().optional(),
  })
  .refine((v) => v.targetBranch !== undefined || v.pathGlobs !== undefined || v.label !== undefined, {
    message: '至少配置一种匹配策略（label / pathGlobs / targetBranch）',
  });
export type PrTriggerRuleCreate = z.infer<typeof PrTriggerRuleCreate>;

export const PrTriggerRule = z.object({
  id: Uuid,
  integrationId: Uuid,
  repoFullName: z.string(),
  targetBranch: z.string().nullable(),
  pathGlobs: z.array(z.string()).nullable(),
  label: z.string().nullable(),
  datasetId: Uuid,
  targetId: Uuid.nullable(),
  enabled: z.boolean(),
  createdAt: IsoDateTime,
});
export type PrTriggerRule = z.infer<typeof PrTriggerRule>;

// ---------------------------------------------------------------------------
// 出站声明（调用 GitHub API 用——非本平台路由；Q5：Status 必交付 / 评论顺延半批）
// ---------------------------------------------------------------------------

/**
 * `POST /repos/{owner}/{repo}/statuses/{sha}` 的请求体（平台→GitHub 方向的契约声明）。
 * 字段名按 **GitHub wire 格式 snake_case**（`target_url`）——这是出站载荷，
 * 与本平台自身的 camelCase 读取契约不同源。
 */
export const CommitStatusInput = z.object({
  state: z.enum(['error', 'failure', 'pending', 'success']),
  target_url: z.string().url(),
  description: z.string().max(140),
  context: z.string().min(1),
});
export type CommitStatusInput = z.infer<typeof CommitStatusInput>;

/** `POST /repos/{owner}/{repo}/issues/{number}/comments` 的请求体（Q5 评论顺延半批）。 */
export const PRCommentInput = z.object({ body: z.string().min(1) });
export type PRCommentInput = z.infer<typeof PRCommentInput>;
