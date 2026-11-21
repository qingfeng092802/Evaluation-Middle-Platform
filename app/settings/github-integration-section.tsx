'use client';

import * as React from 'react';
import { useSyncExternalStore } from 'react';
import {
  GithubIntegration,
  GithubIntegrationListResponse,
  GithubDeliveryListResponse,
  DatasetListResponse,
  PrTriggerRuleListResponse,
  PrTriggerRuleCreate,
} from '@eval-platform/contracts';
import { apiPatch, apiPost } from '@/lib/ui/client';
import { useApi } from '@/lib/ui/use-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getRole, subscribeRole, type PlatformRole } from '@/lib/ui/role';
import { formatTimestamp } from '@/lib/format';
import {
  canManageIntegrations,
  deliveryStatusLabel,
  EMPTY_GITHUB_DRAFT,
  githubCreateBody,
  githubFormError,
  manageIntegrationsDisabledHint,
  reposSummary,
  triggerRuleCreateBody,
  triggerRuleFormError,
  type GithubIntegrationDraft,
  type TriggerRuleDraft,
} from '@/lib/ui/githubIntegrations';

/** SSR 快照：服务端无 localStorage，恒为默认 A（role-switcher 同款）。 */
const getServerRole = (): PlatformRole => 'A';

/**
 * `PG-09`「GitHub 集成」区块（M5 Batch 4，`US-022` 提案）。
 *
 * 集成 CRUD（凭据只写不读：PEM / webhookSecret 明文仅出现在创建与重置输入框，
 * 卡片渲染只有 `hasPrivateKey` / `hasWebhookSecret` 布尔位）+ 触发规则映射
 * （Q6：绑定 PR 专用冒烟集）+ 投递历史（0022 账本倒序）。
 *
 * 角色语义（2026-11-18 裁定同款）：配置仅 `ROLE-B`；`ROLE-A` 只读——
 * 控件禁用并提示。服务端是唯一裁判（写路径无角色拦截是 M5 范围的已知边界，
 * 与门禁规则 / 基线确认的 decision 403 不同——GitHub 集成的写路径当前仅
 * 本地管理面可达）。
 */
export function GithubIntegrationSection(): React.ReactElement {
  const integrations = useApi(GithubIntegrationListResponse, '/api/integrations/github');
  const role = useSyncExternalStore(subscribeRole, getRole, getServerRole);
  const canManage = canManageIntegrations(role);
  const manageHint = manageIntegrationsDisabledHint(role);

  return (
    <section aria-labelledby="github-heading" className="flex flex-col gap-3">
      <h2 id="github-heading" className="text-sm font-medium text-muted-foreground">
        GitHub 集成（App 私钥 / Webhook Secret 加密落库；凭据写入后不可回显）
      </h2>
      <p className="text-xs text-muted-foreground">{manageHint ?? '当前角色 B（管理员）：可配置集成与触发规则'}</p>

      <GithubCreateForm disabled={!canManage} onSaved={() => integrations.reload()} />

      {integrations.loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          加载中…
        </p>
      ) : (integrations.data?.items ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          还没有 GitHub 集成——用上方表单创建（App 私钥与 Webhook Secret 从 GitHub 侧获取）。
        </p>
      ) : (
        (integrations.data?.items ?? []).map((it) => (
          <GithubIntegrationCard
            key={it.id}
            integration={it}
            disabled={!canManage}
            onChanged={() => {
              integrations.reload();
            }}
          />
        ))
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 创建表单
// ---------------------------------------------------------------------------

function GithubCreateForm({
  disabled,
  onSaved,
}: {
  disabled: boolean;
  onSaved: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<GithubIntegrationDraft>(EMPTY_GITHUB_DRAFT);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    const formError = githubFormError(draft);
    if (formError !== null) {
      setError(formError);
      return;
    }
    const body = githubCreateBody(draft);
    if (body === null) {
      setError('仓库行格式必须为 owner/repo');
      return;
    }
    try {
      const created = await apiPost(GithubIntegration, '/api/integrations/github', body);
      setNotice(`已创建集成：${created.name}（凭据已加密落库，此后不可回显）`);
      setDraft(EMPTY_GITHUB_DRAFT);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const fieldError = githubFormError(draft);

  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-card p-3" id="github-create-form">
      <h3 className="text-sm font-semibold text-foreground">创建 GitHub App 集成</h3>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="gh-name" className="text-xs text-muted-foreground">名称</label>
          <Input id="gh-name" value={draft.name} disabled={disabled}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="如：主仓库集成" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="gh-app-id" className="text-xs text-muted-foreground">App ID</label>
          <Input id="gh-app-id" value={draft.appId} disabled={disabled}
            onChange={(e) => setDraft({ ...draft, appId: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="gh-installation" className="text-xs text-muted-foreground">Installation ID</label>
          <Input id="gh-installation" value={draft.installationId} disabled={disabled}
            onChange={(e) => setDraft({ ...draft, installationId: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="gh-secret" className="text-xs text-muted-foreground">
            Webhook Secret（明文仅此次写入）
          </label>
          <Input id="gh-secret" type="password" value={draft.webhookSecret} disabled={disabled}
            onChange={(e) => setDraft({ ...draft, webhookSecret: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="gh-pem" className="text-xs text-muted-foreground">
          App 私钥（PEM 全文，明文仅此次写入；服务端 AES-256-GCM 加密落库）
        </label>
        <textarea
          id="gh-pem"
          value={draft.privateKey}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })}
          rows={4}
          className="rounded-sm border border-input bg-card px-2 py-1 font-mono text-xs text-foreground"
          placeholder={'-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----'}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="gh-repos" className="text-xs text-muted-foreground">
          绑定仓库（每行一个 owner/repo）
        </label>
        <textarea
          id="gh-repos"
          value={draft.reposInput}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, reposInput: e.target.value })}
          rows={2}
          className="rounded-sm border border-input bg-card px-2 py-1 font-mono text-xs text-foreground"
          placeholder={'owner/repo'}
        />
      </div>
      <div>
        <Button size="sm" disabled={disabled || fieldError !== null} onClick={() => void save()}>
          创建集成
        </Button>
      </div>
      {error !== null ? (
        <p className="text-sm text-eval-fail" role="alert">{error}</p>
      ) : null}
      {notice !== null ? (
        <p className="text-sm text-muted-foreground" role="status">{notice}</p>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// 集成卡片（含触发规则 + 投递历史子块）
// ---------------------------------------------------------------------------

function GithubIntegrationCard({
  integration,
  disabled,
  onChanged,
}: {
  integration: GithubIntegration;
  disabled: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const [error, setError] = React.useState<string | null>(null);

  const toggleActive = async (): Promise<void> => {
    setError(null);
    try {
      await apiPatch(GithubIntegration, `/api/integrations/github/${integration.id}`, {
        isActive: !integration.isActive,
      });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{integration.name}</h3>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          App {integration.appId}
        </span>
        <Badge variant={integration.isActive ? 'pass' : 'muted'}>
          {integration.isActive ? '启用' : '停用'}
        </Badge>
        {integration.hasPrivateKey ? (
          <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">私钥已加密落库</span>
        ) : null}
        {integration.hasWebhookSecret ? (
          <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">Secret 已配置</span>
        ) : null}
      </header>
      <p className="text-xs text-muted-foreground">
        仓库：{reposSummary(integration.repos) !== '' ? reposSummary(integration.repos) : '未绑定'}
        {' · '}Installation {integration.installationId}
      </p>

      {disabled ? null : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void toggleActive()}>
            {integration.isActive ? '停用' : '启用'}
          </Button>
        </div>
      )}

      {error !== null ? (
        <p className="text-sm text-eval-fail" role="alert">{error}</p>
      ) : null}

      <TriggerRulesSubBlock integration={integration} disabled={disabled} />
      <DeliveryHistorySubBlock integration={integration} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// 触发规则子块
// ---------------------------------------------------------------------------

function TriggerRulesSubBlock({
  integration,
  disabled,
}: {
  integration: GithubIntegration;
  disabled: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rules = useApi(PrTriggerRuleListResponse, open ? `/api/pr-trigger-rules?integrationId=${integration.id}` : null);
  const datasets = useApi(DatasetListResponse, '/api/datasets?limit=50');
  const [datasetId, setDatasetId] = React.useState('');
  const [repoFullName, setRepoFullName] = React.useState('');
  const [targetBranch, setTargetBranch] = React.useState('main');
  const [label, setLabel] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    const draft: TriggerRuleDraft = { datasetId, targetBranch, label };
    const formError = triggerRuleFormError(draft);
    if (formError !== null) {
      setError(formError);
      return;
    }
    const repoFullName = prompt('绑定仓库（owner/repo，与集成 repos 一致）：', reposSummary(integration.repos));
    if (repoFullName === null || repoFullName.trim() === '') {
      setError('需要绑定仓库');
      return;
    }
    try {
      const body = triggerRuleCreateBody(draft, integration.id, repoFullName.trim());
      await apiPost(PrTriggerRuleCreate, '/api/pr-trigger-rules', body);
      setNotice('触发规则已创建');
      rules.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-border p-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? '收起触发规则' : '触发规则（PR → 评测集映射）'}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-1">
          {rules.data === null ? (
            <p className="text-xs text-muted-foreground" role="status">
              {rules.loading ? '加载中…' : (rules.error?.message ?? '暂无规则')}
            </p>
          ) : rules.data.items.length === 0 ? (
            <p className="text-xs text-muted-foreground" role="status">还没有触发规则。</p>
          ) : (
            rules.data.items.map((r) => (
              <p key={r.id} className="text-xs text-foreground">
                {r.repoFullName} · 分支 {r.targetBranch ?? '—'} · Label {r.label ?? '—'} ·
                {' '}映射到评测集 {r.datasetId.slice(0, 8)}… · {r.enabled ? '启用' : '停用'}
              </p>
            ))
          )}
          {disabled ? (
            <p className="text-xs text-muted-foreground">规则创建仅 ROLE-B（只读视图）</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <div className="flex flex-col gap-1">
                <label htmlFor={`rule-dataset-${integration.id}`} className="text-xs text-muted-foreground">评测集（冒烟集）</label>
                <select
                  id={`rule-dataset-${integration.id}`}
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                  className="h-9 max-w-[260px] rounded-sm border border-input bg-card px-2 text-sm text-foreground"
                >
                  <option value="">— 选择 —</option>
                  {(datasets.data?.items ?? []).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`rule-repo-${integration.id}`} className="text-xs text-muted-foreground">绑定仓库</label>
                <Input id={`rule-repo-${integration.id}`} value={repoFullName}
                  onChange={(e) => setRepoFullName(e.target.value)} placeholder="owner/repo" />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`rule-branch-${integration.id}`} className="text-xs text-muted-foreground">目标分支</label>
                <Input id={`rule-branch-${integration.id}`} value={targetBranch}
                  onChange={(e) => setTargetBranch(e.target.value)} placeholder="main" />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`rule-label-${integration.id}`} className="text-xs text-muted-foreground">PR Label</label>
                <Input id={`rule-label-${integration.id}`} value={label}
                  onChange={(e) => setLabel(e.target.value)} placeholder="eval-smoke（可空）" />
              </div>
              <Button size="sm" variant="secondary" onClick={() => void save()}>添加规则</Button>
            </div>
          )}
          {error !== null ? <p className="text-sm text-eval-fail" role="alert">{error}</p> : null}
          {notice !== null ? <p className="text-xs text-muted-foreground" role="status">{notice}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 投递历史子块
// ---------------------------------------------------------------------------

function DeliveryHistorySubBlock({ integration }: { integration: GithubIntegration }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const deliveries = useApi(
    GithubDeliveryListResponse,
    open ? `/api/integrations/github/${integration.id}/deliveries` : null,
  );

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-border p-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? '收起投递历史' : '投递历史'}
        </Button>
      </div>
      {open ? (
        deliveries.data === null ? (
          <p className="text-xs text-muted-foreground" role="status">
            {deliveries.loading ? '加载中…' : (deliveries.error?.message ?? '暂无数据')}
          </p>
        ) : deliveries.data.items.length === 0 ? (
          <p className="text-xs text-muted-foreground" role="status">还没有 Webhook 投递记录。</p>
        ) : (
          deliveries.data.items.map((d) => (
            <p key={d.id} className="text-xs text-foreground">
              {deliveryStatusLabel(d.processedStatus)} · {d.event} ·
              {d.summary !== null ? ` PR #${String(d.summary.pr_number)}@${String(d.summary.head_sha).slice(0, 7)}` : ''}
              {' · '}{formatTimestamp(d.receivedAt)}
            </p>
          ))
        )
      ) : null}
    </div>
  );
}
