'use client';

import * as React from 'react';
import type { Metadata } from 'next';
import { EvaluatorTemplateListResponse, EvaluatorTemplate } from '@eval-platform/contracts';
import { apiPatch, apiPost } from '@/lib/ui/client';
import { AppShellWithTheme } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { useApi } from '@/lib/ui/use-api';
import {
  canSubmitJudgeForm,
  judgeFormChanged,
  judgeFormOf,
  partitionTemplates,
  EMPTY_JUDGE_FORM,
  type JudgeTemplateForm,
} from '@/lib/ui/evaluators';

export const metadata: Metadata = { title: '算子库' };

/**
 * `PG-07` 算子库（M4 Batch 4，`US-016`）。
 *
 * 两个分区：**内置六算子只读清单**（不可新建/修改）+ **自定义裁判模板**（CRUD）。
 * 模板 `config` 改版 ⇒ 服务端 `version + 1`；历史 run 的 `run_evaluators` 快照
 * 不可变，不受模板改版影响（PT-1）。
 */
export default function EvaluatorsPage(): React.ReactElement {
  const list = useApi(EvaluatorTemplateListResponse, '/api/evaluators');
  const items = list.data?.items ?? [];
  const { builtin, custom } = partitionTemplates(items);

  const [editing, setEditing] = React.useState<EvaluatorTemplate | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState<JudgeTemplateForm>(EMPTY_JUDGE_FORM);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const startCreate = (): void => {
    setEditing(null);
    setCreating(true);
    setForm(EMPTY_JUDGE_FORM);
    setFormError(null);
  };

  const startEdit = (t: EvaluatorTemplate): void => {
    setCreating(false);
    setEditing(t);
    setForm(judgeFormOf(t));
    setFormError(null);
  };

  const closeForm = (): void => {
    setCreating(false);
    setEditing(null);
    setFormError(null);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);
    if (creating) {
      if (!canSubmitJudgeForm(form)) {
        setFormError('请补全 key / 名称 / 厂商 / 模型 / Prompt');
        return;
      }
      setBusy(true);
      try {
        await apiPost(EvaluatorTemplate, '/api/evaluators', {
          key: form.key.trim(),
          displayName: form.displayName.trim(),
          ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
          config: judgeConfigOf(form),
        });
        list.reload();
        closeForm();
      } catch (err) {
        setFormError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (editing === null) return;
    setBusy(true);
    try {
      await apiPatch(EvaluatorTemplate, `/api/evaluators/${editing.id}`, {
        displayName: form.displayName.trim(),
        ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
        // 只有 config 相关字段变化才随 PATCH 带 config（纯改名不推版本）
        ...(judgeFormChanged(form, judgeFormOf(editing))
          ? { config: judgeConfigOf(form) }
          : {}),
      });
      list.reload();
      closeForm();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const builtinColumns = React.useMemo<readonly DataTableColumn<EvaluatorTemplate>[]>(
    () => [
      { id: 'key', header: '算子 key', cell: (t) => <code className="text-xs text-foreground">{t.key}</code>, sortValue: (t) => t.key },
      { id: 'displayName', header: '名称', cell: (t) => <span className="font-medium text-foreground">{t.displayName}</span>, sortValue: (t) => t.displayName },
      { id: 'description', header: '说明', cell: (t) => <span className="truncate text-muted-foreground">{t.description ?? ''}</span>, sortValue: (t) => t.description ?? '' },
    ],
    [],
  );

  const customColumns = React.useMemo<readonly DataTableColumn<EvaluatorTemplate>[]>(
    () => [
      { id: 'key', header: '模板 key', cell: (t) => <code className="text-xs text-foreground">{t.key}</code>, sortValue: (t) => t.key },
      { id: 'displayName', header: '名称', cell: (t) => <span className="font-medium text-foreground">{t.displayName}</span>, sortValue: (t) => t.displayName },
      { id: 'version', header: '版本', cell: (t) => `v${t.version}`, sortValue: (t) => t.version, align: 'end' },
      { id: 'updatedAt', header: '更新时间', cell: (t) => new Date(t.updatedAt).toLocaleString(), sortValue: (t) => t.updatedAt },
    ],
    [],
  );

  return (
    <AppShellWithTheme
      breadcrumbs={[{ label: '算子' }, { label: '算子库' }]}
      actions={
        <Button size="sm" onClick={startCreate}>
          + 新建裁判模板
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <h1 className="text-base font-semibold text-foreground">算子库</h1>

        <section aria-labelledby="builtin-heading" className="flex flex-col gap-2">
          <h2 id="builtin-heading" className="text-sm font-medium text-muted-foreground">
            内置规则算子（只读）
          </h2>
          <DataTable<EvaluatorTemplate>
            rows={builtin}
            columns={builtinColumns}
            getRowId={(t) => t.key}
            loading={list.loading}
          />
        </section>

        <section aria-labelledby="custom-heading" className="flex flex-col gap-2">
          <h2 id="custom-heading" className="text-sm font-medium text-muted-foreground">
            自定义裁判模板
          </h2>
          {custom.length > 0 ? (
            <DataTable<EvaluatorTemplate>
              rows={custom}
              columns={customColumns}
              getRowId={(t) => t.id}
              loading={list.loading}
              onRowClick={startEdit}
              rowAriaLabel={(t) => `编辑模板 ${t.key}`}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {list.loading ? '加载中…' : '还没有自定义裁判模板——点右上角「新建裁判模板」。'}
            </p>
          )}
        </section>

        {creating || editing !== null ? (
          <JudgeForm
            title={creating ? '新建裁判模板' : `编辑模板 ${editing?.key ?? ''}`}
            form={form}
            setForm={setForm}
            error={formError}
            busy={busy}
            keyLocked={!creating}
            onSubmit={submit}
            onCancel={closeForm}
          />
        ) : null}
      </div>
    </AppShellWithTheme>
  );
}

function judgeConfigOf(f: JudgeTemplateForm): {
  key: 'judge';
  modelProviderId: string;
  modelId: string;
  promptTemplate: string;
  scaleMax: 1 | 5 | 10;
  passThreshold: number;
  temperature: number;
} {
  return {
    key: 'judge',
    modelProviderId: f.modelProviderId.trim(),
    modelId: f.modelId.trim(),
    promptTemplate: f.promptTemplate.trim(),
    scaleMax: f.scaleMax,
    passThreshold: f.passThreshold,
    temperature: f.temperature,
  };
}

function JudgeForm({
  title,
  form,
  setForm,
  error,
  busy,
  keyLocked,
  onSubmit,
  onCancel,
}: {
  title: string;
  form: JudgeTemplateForm;
  setForm: (f: JudgeTemplateForm) => void;
  error: string | null;
  busy: boolean;
  keyLocked: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}): React.ReactElement {
  const set = (patch: Partial<JudgeTemplateForm>): void => setForm({ ...form, ...patch });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="judge-key" className="text-xs text-muted-foreground">模板 key（judge.&lt;slug&gt;）</label>
          <Input
            id="judge-key"
            value={form.key}
            onChange={(e) => set({ key: e.target.value })}
            disabled={keyLocked}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="judge-name" className="text-xs text-muted-foreground">名称</label>
          <Input id="judge-name" value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} required />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="judge-provider" className="text-xs text-muted-foreground">裁判厂商 ID</label>
          <Input id="judge-provider" value={form.modelProviderId} onChange={(e) => set({ modelProviderId: e.target.value })} required />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="judge-model" className="text-xs text-muted-foreground">裁判模型</label>
          <Input id="judge-model" value={form.modelId} onChange={(e) => set({ modelId: e.target.value })} required />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="judge-scale" className="text-xs text-muted-foreground">分值上界</label>
          <select
            id="judge-scale"
            value={form.scaleMax}
            onChange={(e) => set({ scaleMax: Number(e.target.value) as 1 | 5 | 10 })}
            className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
          >
            <option value={1}>1</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="judge-threshold" className="text-xs text-muted-foreground">通过阈值（0-1）</label>
          <Input
            id="judge-threshold"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={form.passThreshold}
            onChange={(e) => set({ passThreshold: Number(e.target.value) })}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="judge-prompt" className="text-xs text-muted-foreground">评分 Prompt（必须引用 {'{{input}}'} / {'{{output}}'} / {'{{reference}}'}）</label>
          <textarea
            id="judge-prompt"
            rows={4}
            value={form.promptTemplate}
            onChange={(e) => set({ promptTemplate: e.target.value })}
            required
            className="rounded-sm border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="judge-desc" className="text-xs text-muted-foreground">备注（可选）</label>
          <Input id="judge-desc" value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </div>
      </div>
      {error !== null ? (
        <p className="text-sm text-eval-fail" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2 self-end">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? '提交中…' : '保存'}
        </Button>
      </div>
    </form>
  );
}
