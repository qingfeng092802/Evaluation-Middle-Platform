'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import {
  ModelProviderListResponse,
  TARGET_T2_ENABLED,
  Target,
  TargetListResponse,
  TargetVersionListResponse,
} from '@eval-platform/contracts';
import type { ModelProvider } from '@eval-platform/contracts';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { apiPatch, apiPost } from '@/lib/ui/client';
import { useApi } from '@/lib/ui/use-api';
import { formatTimestamp } from '@/lib/format';
import {
  T2_DISABLED_LABEL,
  currentVersionCell,
  isT2Selectable,
  modelCell,
  modelCellOf,
  nextVersionHint,
  targetKindLabel,
} from '@/lib/ui/targets';

/**
 * `PG-06` · 待测目标。
 *
 * 两块：列表（`名称 ｜ 类型 ｜ 模型 ｜ 当前版本 ｜ 更新时间 ｜ 操作`）+ T1 表单。
 * 「编辑」复用同一个表单：`PATCH /api/targets/{id}` 只在 `config` 变化时才推版本号，
 * 因此表单顶部必须显示「保存后将生成 vN+1，历史运行仍引用 vN」——
 * 那是 `PG-06` 的原文，不是安慰话术（已完成的运行读的是它建 run 时的配置快照）。
 *
 * T2 的「不可用」在三层同时成立，缺一层都会漏：
 *  1. 这里把 `<option>` 标 `disabled` 并写「P1 支持」；
 *  2. `TARGET_T2_ENABLED` 是契约里的**单点开关**，页面直接读它，不另写常量；
 *  3. API 层 `rejectT2IfDisabled()` 收到 `kind='t2_http'` 直接 400 ——
 *     前端置灰从来都不构成保护。
 */
export default function TargetsPage(): React.ReactElement {
  const targets = useApi(TargetListResponse, '/api/targets?limit=50');
  const providers = useApi(ModelProviderListResponse, '/api/providers');
  /** 非 null ⇒ 展开该目标的版本历史 + 编辑表单。 */
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const active = React.useMemo(
    () => (targets.data?.items ?? []).find((t) => t.id === activeId) ?? null,
    [targets.data, activeId],
  );

  const columns = React.useMemo<readonly DataTableColumn<Target>[]>(
    () => [
      {
        id: 'name',
        header: '名称',
        cell: (t) => <span className="truncate font-medium text-foreground">{t.name}</span>,
        sortValue: (t) => t.name,
      },
      {
        id: 'kind',
        header: '类型',
        cell: (t) => targetKindLabel(t.kind),
        sortValue: (t) => t.kind,
      },
      {
        id: 'model',
        header: '模型',
        cell: (t) => <span className="num-mono text-xs">{modelCell(t)}</span>,
        sortValue: (t) => modelCell(t),
      },
      {
        id: 'version',
        header: '当前版本',
        numeric: true,
        cell: (t) => currentVersionCell(t.currentVersionNo),        sortValue: (t) => t.currentVersionNo,
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        numeric: true,
        cell: (t) => <span className="num-mono">{formatTimestamp(t.updatedAt)}</span>,
        sortValue: (t) => t.updatedAt,
      },
      {
        id: 'actions',
        header: '操作',
        cell: (t) => (
          <span className="flex items-center gap-3">
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline"
              aria-expanded={activeId === t.id}
              onClick={(e) => {
                e.stopPropagation();
                setActiveId((cur) => (cur === t.id ? null : t.id));
              }}
            >
              查看版本
            </button>
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                setActiveId(t.id);
                // 展开后把焦点交给表单，省掉一次滚动找输入框
                window.setTimeout(() => {
                  document.getElementById('target-form-name')?.focus();
                }, 0);
              }}
            >
              编辑
            </button>
          </span>
        ),
        srOnlyHeader: '（展开该目标的版本历史与编辑表单）',
      },
    ],
    [activeId],
  );

  return (
    <AppShellWithTheme
      breadcrumbs={[{ label: '待测目标', href: '/targets' }]}
      actions={
        <Button asChild size="sm">
          <a href="#target-form">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> 新建目标
          </a>
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <h1 className="text-base font-semibold text-foreground">待测目标</h1>

        {targets.error !== null ? (
          <div className="rounded-md border border-eval-fail bg-eval-fail-bg px-3 py-2 text-sm text-eval-fail">
            加载失败：{targets.error.message}
          </div>
        ) : null}

        <DataTable<Target>
          columns={columns}
          rows={targets.data?.items ?? []}
          getRowId={(t) => t.id}
          loading={targets.loading}
          refreshing={targets.refreshing}
          emptyKey="targets"
          rowAriaLabel={(t) => `待测目标 ${t.name}`}
        />

        {active === null ? null : (
          <TargetVersionHistory targetId={active.id} onClose={() => setActiveId(null)} />
        )}

        <TargetForm
          // key 换掉整个表单 = 换编辑对象时状态归位。比在 effect 里重填更可靠：
          // 列表刷新会换掉 `active` 的引用，若靠 effect 重填，用户正在输入的内容会被悄悄清掉。
          key={active?.id ?? 'new'}
          providers={providers.data?.items ?? []}
          providersError={providers.error?.message ?? null}
          editing={active}
          onSaved={() => {
            targets.reload();
          }}
          onCancelEdit={() => setActiveId(null)}
        />
      </div>
    </AppShellWithTheme>
  );
}

// ---------------------------------------------------------------------------
// 版本历史（只读）
// ---------------------------------------------------------------------------

/**
 * 版本历史。
 *
 * 只读：`GET /api/targets/{id}/versions` 是唯一的版本读取入口，
 * 服务端没有 PUT / DELETE 版本的路由——「版本只增不改」不是 UI 约定，是数据库约束。
 */
function TargetVersionHistory({
  targetId,
  onClose,
}: {
  targetId: string;
  onClose: () => void;
}): React.ReactElement {
  const versions = useApi(TargetVersionListResponse, `/api/targets/${targetId}/versions`);
  const items = versions.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>版本历史</CardTitle>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {versions.loading ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : versions.error !== null ? (
          <p className="text-xs text-eval-fail">加载失败：{versions.error.message}</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground">该目标还没有版本。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-xs">
            {items.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <span className="num font-medium text-foreground">v{String(v.versionNo)}</span>
                <span className="num-mono text-muted-foreground">{modelCellOf(v)}</span>
                <span className="text-muted-foreground">{v.createdBy}</span>
                <span className="num-mono text-muted-foreground">
                  {formatTimestamp(v.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 表单（新建 / 编辑共用）
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  modelProviderId: string;
  modelId: string;
  promptTemplate: string;
  temperature: string;
  maxTokens: string;
}

const INITIAL: FormState = {
  name: '',
  modelProviderId: '',
  modelId: '',
  promptTemplate: '请根据输入回答问题：{{input}}',
  temperature: '0.2',
  maxTokens: '512',
};

/**
 * 把已有目标回填进表单。
 *
 * T1 才回填配置字段；`currentVersion === null` 或 T2（P0 不可达）时只回填名称，
 * 让用户从空白开始填，而不是看到一个半空的表单被当成「已加载」。
 */
function formFromTarget(t: Target): FormState {
  const v = t.currentVersion;
  if (v === null || v.config.kind !== 't1_prompt') {
    return { ...INITIAL, name: t.name };
  }
  return {
    name: t.name,
    modelProviderId: v.config.modelProviderId,
    modelId: v.config.modelId,
    promptTemplate: v.config.promptTemplate,
    temperature: String(v.config.temperature),
    maxTokens: String(v.config.maxTokens),
  };
}

function TargetForm({
  providers,
  providersError,
  editing,
  onSaved,
  onCancelEdit,
}: {
  providers: readonly ModelProvider[];
  providersError: string | null;
  /** `null` ⇒ 新建。 */
  editing: Target | null;
  onSaved: () => void;
  onCancelEdit: () => void;
}): React.ReactElement {
  // 初值一次到位：编辑对象的切换由父组件的 `key` 触发重挂载，
  // 因此这里不需要 effect 去「同步 props → state」。
  const [form, setForm] = React.useState<FormState>(() =>
    editing === null ? INITIAL : formFromTarget(editing),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const editingVersionNo = editing?.currentVersionNo ?? 0;

  const effectiveProvider =
    form.modelProviderId !== '' ? form.modelProviderId : (providers[0]?.id ?? '');
  const t2Enabled = isT2Selectable(TARGET_T2_ENABLED);
  const canSubmit =
    !busy &&
    form.name.trim() !== '' &&
    form.modelId.trim() !== '' &&
    form.promptTemplate.trim() !== '' &&
    effectiveProvider !== '' &&
    !Number.isNaN(Number(form.temperature)) &&
    !Number.isNaN(Number(form.maxTokens));

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
    setNotice(null);
  }

  function buildConfig(): unknown {
    return {
      kind: 't1_prompt',
      modelProviderId: effectiveProvider,
      modelId: form.modelId.trim(),
      promptTemplate: form.promptTemplate,
      temperature: Number(form.temperature),
      maxTokens: Number(form.maxTokens),
    };
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (editing === null) {
        const created = await apiPost(Target, '/api/targets', {
          name: form.name.trim(),
          config: buildConfig(),
        });
        setForm(INITIAL);
        setNotice(`已创建 ${created.name}（v${String(created.currentVersionNo)}）`);
      } else {
        const before = editing.currentVersionNo;
        const updated = await apiPatch(Target, `/api/targets/${editing.id}`, {
          name: form.name.trim(),
          config: buildConfig(),
        });
        // 版本号是否推进由服务端决定（config 深比较），前端只负责如实复述。
        setNotice(
          updated.currentVersionNo === before
            ? `已保存（配置未变，仍是 v${String(before)}）`
            : `已生成 v${String(updated.currentVersionNo)}，历史运行仍引用 v${String(before)}`,
        );
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="target-form">
      <CardHeader>
        <CardTitle>{editing === null ? '新建待测目标' : `编辑「${editing.name}」`}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <Label htmlFor="target-form-name">名称</Label>
              <Input
                id="target-form-name"
                value={form.name}
                required
                maxLength={120}
                onChange={(e) => set('name', e.target.value)}
                placeholder="如：客服问答-v1"
              />
            </div>
            <div className="flex min-w-[180px] flex-col gap-1">
              <Label htmlFor="target-form-kind">类型</Label>
              {/*
                只有一个可选项（T1），因此不做 state：T2 仍是 disabled 的 `<option>`，
                选不中就没有第二份表单要渲染。P1 打开 T2 时必须同时补 T2 字段区。
              */}
              <Select id="target-form-kind" defaultValue="t1_prompt">
                <option value="t1_prompt">{targetKindLabel('t1_prompt')}</option>
                <option value="t2_http" disabled={!t2Enabled}>
                  {targetKindLabel('t2_http')}
                  {t2Enabled ? '' : `（${T2_DISABLED_LABEL}）`}
                </option>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <Label htmlFor="target-form-provider">模型网关</Label>
              <Select
                id="target-form-provider"
                value={effectiveProvider}
                onChange={(e) => set('modelProviderId', e.target.value)}
              >
                {providers.length === 0 ? <option value="">（还没有厂商）</option> : null}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（{p.apiKeyMasked}）
                  </option>
                ))}
              </Select>
              {providersError !== null ? (
                <p className="text-2xs text-eval-fail">厂商加载失败：{providersError}</p>
              ) : null}
            </div>
            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <Label htmlFor="target-form-model">模型</Label>
              <Input
                id="target-form-model"
                value={form.modelId}
                required
                onChange={(e) => set('modelId', e.target.value)}
                placeholder="如：fixture-echo-1"
                className="num-mono"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="target-form-prompt">Prompt 模板</Label>
            <Textarea
              id="target-form-prompt"
              value={form.promptTemplate}
              required
              onChange={(e) => set('promptTemplate', e.target.value)}
              className="min-h-[96px] font-mono text-xs"
            />
            <p className="text-2xs text-muted-foreground">
              变量写作 {'{{input}}'}；平台把它替换为该条 Case 的 `input`。
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="flex w-[160px] flex-col gap-1">
              <Label htmlFor="target-form-temp">temperature</Label>
              <Input
                id="target-form-temp"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(e) => set('temperature', e.target.value)}
                className="num"
              />
            </div>
            <div className="flex w-[160px] flex-col gap-1">
              <Label htmlFor="target-form-max-tokens">max_tokens</Label>
              <Input
                id="target-form-max-tokens"
                type="number"
                min={1}
                step={1}
                value={form.maxTokens}
                onChange={(e) => set('maxTokens', e.target.value)}
                className="num"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {editing === null ? '保存' : '保存并生成新版本'}
            </Button>
            <span className="text-xs text-muted-foreground">
              {/* 新建时还没有版本号，说「将生成 v2」就是假话；编辑时才用 PG-06 原文。 */}
              {editing === null
                ? '首次保存将生成 v1'
                : nextVersionHint(editingVersionNo)}
            </span>
            {editing === null ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={onCancelEdit}>
                取消编辑
              </Button>
            )}
          </div>

          {busy ? <p className="text-xs text-muted-foreground">提交中…</p> : null}
          {notice !== null ? <p className="text-xs text-eval-pass">{notice}</p> : null}
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
