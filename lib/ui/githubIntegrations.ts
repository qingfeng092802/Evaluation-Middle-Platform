/**
 * PG-09「GitHub 集成」区块的派生层（M5 Batch 4，`US-022` 提案）。
 *
 * 与 `lib/ui/gates.ts` / `lib/ui/baselines.ts` 同一惯例：表单派生 / 校验 /
 * 请求体形状全在这里，页面组件只做渲染与状态。
 *
 * 角色语义（需求方 2026-11-18 裁定同款）：GitHub 集成配置是 `ROLE-B` 能力
 * （`US-022` 提案）；`ROLE-A` 只读——列表可见，新建 / 编辑 / 启停控件禁用并提示。
 *
 * **凭据零回显**：`privateKey` / `webhookSecret` 只存在于创建 / 重置输入框
 * （写入形状），卡片渲染只有 `hasPrivateKey` / `hasWebhookSecret` 布尔位。
 */
import type { PlatformRole } from './role.js';

// ---------------------------------------------------------------------------
// 仓库绑定输入（owner/repo 逐行）
// ---------------------------------------------------------------------------

/** `owner/repo` 逐行解析。任一行非法 → null（整体拒绝，不静默丢行）。 */
export function parseReposInput(text: string): Array<{ readonly owner: string; readonly repo: string }> | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return [];
  const repos: Array<{ readonly owner: string; readonly repo: string }> = [];
  for (const line of lines) {
    const parts = line.split('/');
    if (parts.length !== 2 || parts[0] === undefined || parts[0] === '' || parts[1] === undefined || parts[1] === '') {
      return null;
    }
    repos.push({ owner: parts[0], repo: parts[1] });
  }
  return repos;
}

/** 仓库摘要（卡片头）：`o/r、x/y`；空 → 空串（调用方渲染「未绑定仓库」）。 */
export function reposSummary(repos: ReadonlyArray<{ readonly owner: string; readonly repo: string }>): string {
  return repos.map((r) => `${r.owner}/${r.repo}`).join('、');
}

// ---------------------------------------------------------------------------
// 集成创建表单
// ---------------------------------------------------------------------------

export interface GithubIntegrationDraft {
  readonly name: string;
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly reposInput: string;
}

export const EMPTY_GITHUB_DRAFT: GithubIntegrationDraft = {
  name: '',
  appId: '',
  installationId: '',
  privateKey: '',
  webhookSecret: '',
  reposInput: '',
};

/** 表单校验：返回第一个错误文案；合法 → null。 */
export function githubFormError(draft: GithubIntegrationDraft): string | null {
  if (draft.name.trim() === '') return '名称不可为空';
  if (draft.appId.trim() === '') return 'App ID 不可为空';
  if (draft.installationId.trim() === '') return 'Installation ID 不可为空';
  if (draft.privateKey.trim() === '') return '私钥（PEM）不可为空';
  if (draft.webhookSecret.trim() === '') return 'Webhook Secret 不可为空';
  const repos = parseReposInput(draft.reposInput);
  if (repos === null) return '仓库行格式必须为 owner/repo（每行一个）';
  if (repos.length === 0) return '至少绑定一个仓库（owner/repo，每行一个）';
  return null;
}

/**
 * `POST /api/integrations/github` 请求体；`reposInput` 无法解析 → **null**
 * （调用方短路，不发送半成品请求）。
 */
export function githubCreateBody(
  draft: GithubIntegrationDraft,
  _datasetIgnored?: string,
): {
  name: string;
  appId: string;
  installationId: string;
  privateKey: string;
  webhookSecret: string;
  repos: ReadonlyArray<{ readonly owner: string; readonly repo: string }>;
} | null {
  const repos = parseReposInput(draft.reposInput);
  if (repos === null) return null;
  return {
    name: draft.name.trim(),
    appId: draft.appId.trim(),
    installationId: draft.installationId.trim(),
    privateKey: draft.privateKey,
    webhookSecret: draft.webhookSecret,
    repos,
  };
}

// ---------------------------------------------------------------------------
// 角色语义（US-022 提案：GitHub 集成配置仅 ROLE-B，A 只读）
// ---------------------------------------------------------------------------

export function canManageIntegrations(role: PlatformRole): boolean {
  return role === 'B';
}

export function manageIntegrationsDisabledHint(role: PlatformRole): string | null {
  return canManageIntegrations(role) ? null : 'GitHub 集成配置仅 ROLE-B；当前为只读视图';
}

// ---------------------------------------------------------------------------
// 投递历史行标签（0024 枚举六态全覆盖）
// ---------------------------------------------------------------------------

export function deliveryStatusLabel(status: string): string {
  switch (status) {
    case 'TRIGGERED':
      return '已触发';
    case 'SKIPPED_CLOSED':
      return '跳过（PR 已关闭）';
    case 'SKIPPED_UNBOUND':
      return '跳过（未绑定仓库）';
    case 'DEDUPED':
      return '去重（重放）';
    case 'REJECTED_SIGNATURE':
      return '签名拒绝';
    case 'SKIPPED_EVENT':
      return '跳过（非评测事件）';
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// 触发规则（PR → 评测集映射）
// ---------------------------------------------------------------------------

export interface TriggerRuleDraft {
  readonly datasetId: string;
  readonly targetBranch: string;
  readonly label: string;
}

/** 表单校验：datasetId 必选 + 至少一种匹配策略（契约 refine 同口径）。 */
export function triggerRuleFormError(draft: TriggerRuleDraft): string | null {
  if (draft.datasetId === '') return '请选择评测集';
  if (draft.targetBranch.trim() === '' && draft.label.trim() === '') {
    return '至少配置一种匹配策略（Label / 目标分支）';
  }
  return null;
}

/** `POST /api/pr-trigger-rules` 请求体；空策略字段归一为 null（不送空串）。 */
export function triggerRuleCreateBody(
  draft: TriggerRuleDraft,
  integrationId: string,
  repoFullName: string,
): {
  integrationId: string;
  repoFullName: string;
  targetBranch: string | null;
  label: string | null;
  datasetId: string;
} {
  return {
    integrationId,
    repoFullName,
    targetBranch: draft.targetBranch.trim() === '' ? null : draft.targetBranch.trim(),
    label: draft.label.trim() === '' ? null : draft.label.trim(),
    datasetId: draft.datasetId,
  };
}
