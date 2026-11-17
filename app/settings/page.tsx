'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
  ModelPriceListResponse,
  ModelProvider,
  ModelProviderListResponse,
  ModelPrice,
} from '@eval-platform/contracts';
import type { ModelProvider as Provider } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Input, Label, Select } from '@/components/ui/input';
import { apiPatch, apiPost } from '@/lib/ui/client';
import { useApi } from '@/lib/ui/use-api';
import { formatTimestamp } from '@/lib/format';
import {
  EMPTY_PROVIDER_DRAFT,
  concurrencyCell,
  emptyPriceDraft,
  priceCell,
  priceFormError,
  priceRequestBody,
  providerActiveLabel,
  providerFormError,
  providerKeyHint,
  providerKindLabel,
  providerRequestBody,
  type PriceDraft,
  type ProviderDraft,
} from '@/lib/ui/providers';
import { ChannelsSection } from './channels-section';

/**
 * `PG-09` · 管理配置 —— **模型网关 Tab**（`US-015`，M2 · Batch 2）。
 *
 * 两个区块：
 *  1. **厂商**：列表（名称 / 类型 / Key 掩码 / 并发上限 / 状态 / 更新时间）
 *     + 新建/编辑表单。Key 只写不读：输入框初值恒为空，已有 Key 只以掩码旁注。
 *  2. **单价**：按厂商列出千 Token 单价（调价只增行、不改行）+ 新增表单。
 *
 * 另外三个 Tab（门禁规则 / 基线确认 / 推送渠道）仍是 M4，这里不给死链，
 * 只写一句「未上线」并说明归属。
 *
 * ⚠️ 本页不发任何未声明的请求：只打 `/api/providers`、`/api/providers/{id}`、`/api/prices`。
 */

/** 尚未交付的 Tab。只为让用户知道「不是坏了」，不给可点入口。 */
const PENDING_TABS: readonly { readonly label: string; readonly milestone: string }[] = [
  { label: '门禁规则', milestone: 'M4' },
  { label: '基线确认', milestone: 'M4' },
];

type SettingsTab = 'providers' | 'channels';

function tabOf(t: SettingsTab): string {
  return t === 'providers' ? '模型网关' : '推送渠道';
}

export default function SettingsPage(): React.ReactElement {
  const providers = useApi(ModelProviderListResponse, '/api/providers');
  const [editing, setEditing] = React.useState<Provider | null>(null);
  const [tab, setTab] = React.useState<SettingsTab>('providers');

  const items = providers.data?.items ?? [];

  return (
    <AppShellWithTheme
      breadcrumbs={[{ label: '管理' }, { label: '管理配置' }]}
      actions={
        tab === 'providers' ? (
          <Button asChild size="sm">
            <a href="#provider-form">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> 新建厂商
            </a>
          </Button>
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <h1 className="text-base font-semibold text-foreground">管理配置</h1>

        {/* Tab 条：模型网关 / 推送渠道可切换；其余标注归属里程碑（不是死链）。 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
          <button
            type="button"
            onClick={() => setTab('providers')}
            aria-current={tab === 'providers' ? 'page' : undefined}
            className={cnTab(tab === 'providers')}
          >
            {tabOf('providers')}
          </button>
          <button
            type="button"
            onClick={() => setTab('channels')}
            aria-current={tab === 'channels' ? 'page' : undefined}
            className={cnTab(tab === 'channels')}
          >
            {tabOf('channels')}
          </button>
          {PENDING_TABS.map((t) => (
            <span key={t.label} className="px-3 py-1 text-sm text-muted-foreground">
              {t.label}（{t.milestone} 上线）
            </span>
          ))}
        </div>

        {tab === 'providers' ? (
          <>
            <ProviderSection
              providers={items}
              loading={providers.loading}
              error={providers.error?.message ?? null}
              onChanged={() => {
                providers.reload();
              }}
              editing={editing}
              setEditing={setEditing}
            />

            <PriceSection
              providers={items}
              onCreated={() => {
                providers.reload();
              }}
            />
          </>
        ) : (
          <ChannelsSection />
        )}
      </div>
    </AppShellWithTheme>
  );
}

/** Tab 条按钮的激活样式（激活 = muted 底；未激活 = 纯文字）。 */
function cnTab(active: boolean): string {
  return active
    ? 'rounded-md bg-muted px-3 py-1 text-sm font-medium text-foreground'
    : 'rounded-md px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground';
}

// ---------------------------------------------------------------------------
// 厂商区块
// ---------------------------------------------------------------------------

function ProviderSection({
  providers,
  loading,
  error,
  onChanged,
  editing,
  setEditing,
}: {
  providers: readonly Provider[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
  editing: Provider | null;
  setEditing: (p: Provider | null) => void;
}): React.ReactElement {
  const columns = React.useMemo<readonly DataTableColumn<Provider>[]>(
    () => [
      {
        id: 'name',
        header: '名称',
        cell: (p) => <span className="truncate font-medium text-foreground">{p.name}</span>,
        sortValue: (p) => p.name,
      },
      {
        id: 'kind',
        header: '类型',
        cell: (p) => providerKindLabel(p.kind),
        sortValue: (p) => p.kind,
      },
      {
        id: 'apiKeyMasked',
        header: 'API Key',
        cell: (p) => <span className="num-mono text-xs">{p.apiKeyMasked}</span>,
        sortValue: (p) => p.apiKeyMasked,
      },
      {
        id: 'maxConcurrency',
        header: '并发上限',
        numeric: true,
        cell: (p) => concurrencyCell(p.maxConcurrency),
        sortValue: (p) => p.maxConcurrency,
      },
      {
        id: 'isActive',
        header: '状态',
        cell: (p) => (
          <Badge variant={p.isActive ? 'pass' : 'muted'}>{providerActiveLabel(p.isActive)}</Badge>
        ),
        sortValue: (p) => (p.isActive ? 1 : 0),
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        numeric: true,
        cell: (p) => <span className="num-mono">{formatTimestamp(p.updatedAt)}</span>,
        sortValue: (p) => p.updatedAt,
      },
      {
        id: 'actions',
        header: '操作',
        cell: (p) => (
          <button
            type="button"
            className="text-primary underline-offset-4 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(p);
              window.setTimeout(() => {
                document.getElementById('provider-form-name')?.focus();
              }, 0);
            }}
          >
            编辑
          </button>
        ),
        srOnlyHeader: '（编辑该厂商）',
      },
    ],
    [setEditing],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型厂商</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            加载失败：{error}
          </div>
        ) : null}

        <DataTable<Provider>
          columns={columns}
          rows={providers}
          getRowId={(p) => p.id}
          loading={loading}
          emptyKey="providers"
          rowAriaLabel={(p) => `厂商 ${p.name}`}
        />

        <ProviderForm
          // 换编辑对象时整体重挂载 ⇒ 表单状态归位，不靠 effect 回填。
          key={editing?.id ?? 'new'}
          editing={editing}
          onSaved={(saved) => {
            onChanged();
            // 保存成功后退出编辑态：留在编辑态会让用户以为「还没保存」。
            setEditing(saved === null ? null : null);
          }}
          onCancel={() => setEditing(null)}
        />
      </CardContent>
    </Card>
  );
}

function ProviderForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing: Provider | null;
  onSaved: (saved: Provider | null) => void;
  onCancel: () => void;
}): React.ReactElement {
  // 编辑时也只回填名称/类型/baseUrl/并发；`apiKey` **恒为空**（见 lib/ui/providers.ts）。
  const [form, setForm] = React.useState<ProviderDraft>(() =>
    editing === null
      ? EMPTY_PROVIDER_DRAFT
      : {
          name: editing.name,
          kind: editing.kind,
          baseUrl: editing.baseUrl ?? '',
          apiKey: '',
          maxConcurrency: String(editing.maxConcurrency),
          isActive: editing.isActive,
        },
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const mode = editing === null ? 'create' : 'update';
  const formError = providerFormError(form, mode);

  function set<K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
    setNotice(null);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (formError !== null) {
      setError(formError);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (editing === null) {
        const created = await apiPost(ModelProvider, '/api/providers', providerRequestBody(form, 'create'));
        setForm(EMPTY_PROVIDER_DRAFT);
        setNotice(`已创建 ${created.name}（Key 掩码 ${created.apiKeyMasked}）`);
      } else {
        const updated = await apiPatch(
          ModelProvider,
          `/api/providers/${editing.id}`,
          providerRequestBody(form, 'update'),
        );
        setNotice(
          form.apiKey.trim() === ''
            ? `已保存（Key 未修改，仍为 ${updated.apiKeyMasked}）`
            : `已保存（Key 已更新为 ${updated.apiKeyMasked}）`,
        );
        // 清掉输入框里的明文，避免它一直留在界面上
        setForm((f) => ({ ...f, apiKey: '' }));
      }
      onSaved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="provider-form" className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-sm font-medium text-foreground">
        {editing === null ? '新建厂商' : `编辑「${editing.name}」`}
      </h3>

      <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
        <div className="flex flex-wrap gap-3">
          <div className="flex min-w-[220px] flex-1 flex-col gap-1">
            <Label htmlFor="provider-form-name">名称</Label>
            <Input
              id="provider-form-name"
              value={form.name}
              required
              maxLength={120}
              onChange={(e) => set('name', e.target.value)}
              placeholder="如：DeepSeek 主账号"
            />
          </div>
          <div className="flex min-w-[180px] flex-col gap-1">
            <Label htmlFor="provider-form-kind">类型</Label>
            <Select
              id="provider-form-kind"
              value={form.kind}
              onChange={(e) => set('kind', e.target.value as ProviderDraft['kind'])}
            >
              <option value="openai_compatible">{providerKindLabel('openai_compatible')}</option>
              <option value="anthropic">{providerKindLabel('anthropic')}</option>
              <option value="litellm">{providerKindLabel('litellm')}</option>
            </Select>
          </div>
          <div className="flex w-[160px] flex-col gap-1">
            <Label htmlFor="provider-form-concurrency">并发上限</Label>
            <Input
              id="provider-form-concurrency"
              type="number"
              min={1}
              max={64}
              step={1}
              value={form.maxConcurrency}
              onChange={(e) => set('maxConcurrency', e.target.value)}
              className="num"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="flex min-w-[260px] flex-1 flex-col gap-1">
            <Label htmlFor="provider-form-base-url">网关地址（baseUrl）</Label>
            <Input
              id="provider-form-base-url"
              value={form.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
              placeholder="https://api.deepseek.com（官方直连可留空）"
              className="num-mono"
            />
          </div>
          <div className="flex min-w-[260px] flex-1 flex-col gap-1">
            <Label htmlFor="provider-form-api-key">API Key</Label>
            <Input
              id="provider-form-api-key"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder={editing === null ? 'sk-…' : '留空则保留原 Key'}
              className="num-mono"
            />
            <p className="text-2xs text-muted-foreground">{providerKeyHint(editing)}</p>
          </div>
        </div>

        {formError !== null ? <p className="text-xs text-eval-warn">{formError}</p> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || formError !== null}>
            {editing === null ? '保存' : '保存修改'}
          </Button>
          {editing === null ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              取消编辑
            </Button>
          )}
          {busy ? <span className="text-xs text-muted-foreground">提交中…</span> : null}
          {notice !== null ? <span className="text-xs text-eval-pass">{notice}</span> : null}
        </div>

        {error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-xs text-eval-fail">
            {error}
          </div>
        ) : null}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 单价区块
// ---------------------------------------------------------------------------

function PriceSection({
  providers,
  onCreated,
}: {
  providers: readonly Provider[];
  onCreated: () => void;
}): React.ReactElement {
  const defaultProviderId = providers[0]?.id ?? '';
  const prices = useApi(ModelPriceListResponse, '/api/prices');
  const [draft, setDraft] = React.useState<PriceDraft>(() => emptyPriceDraft(defaultProviderId));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const formError = priceFormError(draft);
  const providerName = React.useMemo(() => {
    const map = new Map(providers.map((p) => [p.id, p.name]));
    return (id: string): string => map.get(id) ?? id;
  }, [providers]);

  const columns = React.useMemo<readonly DataTableColumn<ModelPrice>[]>(
    () => [
      {
        id: 'provider',
        header: '厂商',
        cell: (r) => <span className="truncate">{providerName(r.modelProviderId)}</span>,
        sortValue: (r) => providerName(r.modelProviderId),
      },
      {
        id: 'modelId',
        header: '模型标识',
        cell: (r) => <span className="num-mono text-xs">{r.modelId}</span>,
        sortValue: (r) => r.modelId,
      },
      {
        id: 'input',
        header: '输入 / 千 Token',
        numeric: true,
        cell: (r) => <span className="num">{priceCell(r.inputPricePer1k, r.currency)}</span>,
        sortValue: (r) => r.inputPricePer1k,
      },
      {
        id: 'output',
        header: '输出 / 千 Token',
        numeric: true,
        cell: (r) => <span className="num">{priceCell(r.outputPricePer1k, r.currency)}</span>,
        sortValue: (r) => r.outputPricePer1k,
      },
      {
        id: 'effectiveFrom',
        header: '生效时点',
        numeric: true,
        cell: (r) => <span className="num-mono">{formatTimestamp(r.effectiveFrom)}</span>,
        sortValue: (r) => r.effectiveFrom,
      },
    ],
    [providerName],
  );

  function set<K extends keyof PriceDraft>(key: K, value: PriceDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
    setNotice(null);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (formError !== null) {
      setError(formError);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiPost(ModelPrice, '/api/prices', priceRequestBody(draft));
      setNotice(`已新增报价：${created.modelId} ${priceCell(created.inputPricePer1k, created.currency)} / ${priceCell(created.outputPricePer1k, created.currency)}`);
      // 保留厂商，清掉其余字段：连续给同一家厂商报多个模型价是常见操作
      setDraft(emptyPriceDraft(draft.modelProviderId));
      prices.reload();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型单价</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-2xs text-muted-foreground">
          成本**只**由本表单价 × token 计算，永不采信上游网关的成本统计。调价请新增一行，
          旧行不会被修改 —— 历史运行永远对得上当时的单价。
        </p>

        {prices.error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            加载失败：{prices.error.message}
          </div>
        ) : null}

        <DataTable<ModelPrice>
          columns={columns}
          rows={prices.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={prices.loading}
          refreshing={prices.refreshing}
          emptyKey="prices"
        />

        <form
          className="flex flex-col gap-3 border-t border-border pt-3"
          onSubmit={(e) => void onSubmit(e)}
        >
          <h3 className="text-sm font-medium text-foreground">新增报价</h3>

          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1">
              <Label htmlFor="price-form-provider">厂商</Label>
              <Select
                id="price-form-provider"
                value={draft.modelProviderId}
                onChange={(e) => set('modelProviderId', e.target.value)}
              >
                {providers.length === 0 ? <option value="">（还没有厂商）</option> : null}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex min-w-[180px] flex-1 flex-col gap-1">
              <Label htmlFor="price-form-model-id">模型标识</Label>
              <Input
                id="price-form-model-id"
                value={draft.modelId}
                onChange={(e) => set('modelId', e.target.value)}
                placeholder="如：deepseek-chat"
                className="num-mono"
              />
            </div>
            <div className="flex min-w-[180px] flex-1 flex-col gap-1">
              <Label htmlFor="price-form-display-name">展示名</Label>
              <Input
                id="price-form-display-name"
                value={draft.displayName}
                onChange={(e) => set('displayName', e.target.value)}
                placeholder="如：DeepSeek Chat"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="flex w-[170px] flex-col gap-1">
              <Label htmlFor="price-form-input">输入 / 千 Token</Label>
              <Input
                id="price-form-input"
                type="number"
                min={0}
                step={0.0001}
                value={draft.inputPricePer1k}
                onChange={(e) => set('inputPricePer1k', e.target.value)}
                className="num"
                placeholder="0.001"
              />
            </div>
            <div className="flex w-[170px] flex-col gap-1">
              <Label htmlFor="price-form-output">输出 / 千 Token</Label>
              <Input
                id="price-form-output"
                type="number"
                min={0}
                step={0.0001}
                value={draft.outputPricePer1k}
                onChange={(e) => set('outputPricePer1k', e.target.value)}
                className="num"
                placeholder="0.002"
              />
            </div>
            <div className="flex w-[120px] flex-col gap-1">
              <Label htmlFor="price-form-currency">货币</Label>
              <Select
                id="price-form-currency"
                value={draft.currency}
                onChange={(e) => set('currency', e.target.value as PriceDraft['currency'])}
              >
                <option value="CNY">CNY</option>
                <option value="USD">USD</option>
              </Select>
            </div>
            <div className="flex min-w-[220px] flex-col gap-1">
              <Label htmlFor="price-form-effective">生效时点（留空 = 立即）</Label>
              <Input
                id="price-form-effective"
                type="datetime-local"
                value={draft.effectiveFrom}
                onChange={(e) => set('effectiveFrom', e.target.value)}
                className="num-mono"
              />
            </div>
          </div>

          {formError !== null ? <p className="text-xs text-eval-warn">{formError}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={busy || formError !== null}>
              保存单价
            </Button>
            {busy ? <span className="text-xs text-muted-foreground">提交中…</span> : null}
            {notice !== null ? <span className="text-xs text-eval-pass">{notice}</span> : null}
          </div>

          {error !== null ? (
            <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-xs text-eval-fail">
              {error}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
