'use client';

import * as React from 'react';
import {
  DatasetListResponse,
  DispatchLogListResponse,
  RegressionGate,
  RegressionGateListResponse,
} from '@eval-platform/contracts';
import type { OutboundDispatchLog } from '@eval-platform/contracts';
import { apiPatch, apiPost } from '@/lib/ui/client';
import { useApi } from '@/lib/ui/use-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSyncExternalStore } from 'react';
import { getRole, subscribeRole, type PlatformRole } from '@/lib/ui/role';

/** SSR 快照：服务端无 localStorage，恒为默认 A（与首帧渲染一致，防 hydration 抖动）。 */
const getServerRole = (): PlatformRole => 'A';
import { channelsSummaryOf } from '@/lib/ui/channels';
import { formatTimestamp } from '@/lib/format';
import {
  EMPTY_GATE_DRAFT,
  GATE_ACTIONS,
  GATE_METRICS,
  GATE_OPS,
  canManageGates,
  conditionLabel,
  dispatchErrorLabel,
  dispatchStatusLabel,
  draftOfGate,
  gateActiveLabel,
  gateCreateBody,
  gateFormError,
  gateUpdateBody,
  manageGatesDisabledHint,
  type GateRuleDraft,
} from '@/lib/ui/gates';

/**
 * `PG-09`「门禁规则」Tab（M4 收尾，`US-017`）。
 *
 * 按评测集列规则；新建 / 编辑（条件 + 动作）、启用 / 停用、派发历史（0021 留痕，
 * 含失败原因）。角色语义：配置仅 `ROLE-B`（`US-017` 原文）；`ROLE-A` 只读视图，
 * 保存 / 编辑控件禁用并提示（服务端无角色拦截，此处 UI 层表达产品语义）。
 */
export function GatesRulesSection(): React.ReactElement {
  const datasets = useApi(DatasetListResponse, '/api/datasets?limit=50');
  const [datasetId, setDatasetId] = React.useState<string>('');
  const gates = useApi(
    RegressionGateListResponse,
    datasetId === '' ? null : `/api/gates?datasetId=${datasetId}`,
  );
  const role = useSyncExternalStore(subscribeRole, getRole, getServerRole);
  const canManage = canManageGates(role);
  const manageHint = manageGatesDisabledHint(role);

  return (
    <section aria-labelledby="gates-heading" className="flex flex-col gap-3">
      <h2 id="gates-heading" className="text-sm font-medium text-muted-foreground">
        门禁规则（判定不过的规则按动作阻断 / 告警；派发历史含失败原因）
      </h2>
      <p className="text-xs text-muted-foreground">{manageHint ?? '当前角色 B（管理员）：可新建 / 编辑规则'}</p>

      <GateCreateForm datasetId={datasetId} disabled={!canManage} onSaved={() => gates.reload()} />

      <div className="flex flex-col gap-1">
        <label htmlFor="gates-dataset" className="text-xs text-muted-foreground">选择评测集</label>
        <select
          id="gates-dataset"
          value={datasetId}
          onChange={(e) => setDatasetId(e.target.value)}
          className="h-9 max-w-[360px] rounded-sm border border-input bg-card px-2 text-sm text-foreground"
        >
          <option value="">— 选择 —</option>
          {(datasets.data?.items ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {datasetId === '' ? (
        <p className="text-sm text-muted-foreground" role="status">
          选择一个评测集以查看其门禁规则。
        </p>
      ) : gates.loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          加载中…
        </p>
      ) : (gates.data?.items ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          该评测集还没有门禁规则——用上方表单新建一条。
        </p>
      ) : (
        (gates.data?.items ?? []).map((g) => (
          <GateRuleCard
            key={g.id}
            gate={g}
            disabled={!canManage}
            onChanged={() => {
              gates.reload();
            }}
          />
        ))
      )}
    </section>
  );
}

function GateCreateForm({
  datasetId,
  disabled,
  onSaved,
}: {
  datasetId: string;
  disabled: boolean;
  onSaved: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<GateRuleDraft>(EMPTY_GATE_DRAFT);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (datasetId === '') {
      setError('请先选择评测集');
      return;
    }
    const formError = gateFormError(draft);
    if (formError !== null) {
      setError(formError);
      return;
    }
    try {
      await apiPost(RegressionGate, '/api/gates', gateCreateBody(draft, datasetId));
      setNotice(`已创建规则：${draft.name.trim()}`);
      setDraft(EMPTY_GATE_DRAFT);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const fieldError = gateFormError(draft);

  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-card p-3" id="gate-create-form">
      <h3 className="text-sm font-semibold text-foreground">新建门禁规则</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[220px] flex-col gap-1">
          <label htmlFor="gate-name" className="text-xs text-muted-foreground">规则名</label>
          <Input
            id="gate-name"
            value={draft.name}
            disabled={disabled}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setNotice(null);
            }}
            placeholder="如：P0 评测集总分不低于 0.85"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="gate-metric" className="text-xs text-muted-foreground">指标</label>
          <select
            id="gate-metric"
            value={draft.metric}
            disabled={disabled}
            onChange={(e) => {
              setDraft({ ...draft, metric: e.target.value as GateRuleDraft['metric'] });
              setNotice(null);
            }}
            className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
          >
            {GATE_METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="gate-op" className="text-xs text-muted-foreground">条件</label>
          <select
            id="gate-op"
            value={draft.op}
            disabled={disabled}
            onChange={(e) => {
              setDraft({ ...draft, op: e.target.value as GateRuleDraft['op'] });
              setNotice(null);
            }}
            className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
          >
            {GATE_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex w-[120px] flex-col gap-1">
          <label htmlFor="gate-value" className="text-xs text-muted-foreground">阈值</label>
          <Input
            id="gate-value"
            value={draft.value}
            disabled={disabled}
            onChange={(e) => {
              setDraft({ ...draft, value: e.target.value });
              setNotice(null);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="gate-action" className="text-xs text-muted-foreground">动作</label>
          <select
            id="gate-action"
            value={draft.action}
            disabled={disabled}
            onChange={(e) => {
              setDraft({ ...draft, action: e.target.value as GateRuleDraft['action'] });
              setNotice(null);
            }}
            className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
          >
            {GATE_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          disabled={disabled || fieldError !== null}
          title={disabled ? manageGatesDisabledHint('A') ?? undefined : undefined}
          onClick={() => void save()}
        >
          保存规则
        </Button>
      </div>
      {error !== null ? (
        <p className="text-sm text-eval-fail" role="alert">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
    </article>
  );
}

function GateRuleCard({
  gate,
  disabled,
  onChanged,
}: {
  gate: RegressionGate;
  disabled: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<GateRuleDraft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [logsOpen, setLogsOpen] = React.useState(false);
  const logs = useApi(
    DispatchLogListResponse,
    logsOpen ? `/api/gates/${gate.id}/dispatch-logs` : null,
  );

  const saveEdit = async (): Promise<void> => {
    if (draft === null) return;
    setError(null);
    const formError = gateFormError(draft);
    if (formError !== null) {
      setError(formError);
      return;
    }
    try {
      await apiPatch(RegressionGate, `/api/gates/${gate.id}`, gateUpdateBody(draft));
      setDraft(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleActive = async (): Promise<void> => {
    setError(null);
    try {
      await apiPatch(RegressionGate, `/api/gates/${gate.id}`, { isActive: !gate.isActive });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{gate.name}</h3>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">{gate.action}</span>
        <code className="text-xs text-muted-foreground">{conditionLabel(gate.condition)}</code>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {gateActiveLabel(gate.isActive)}
        </span>
        {channelsSummaryOf(gate) !== '' ? (
          <span className="text-xs text-muted-foreground">渠道：{channelsSummaryOf(gate)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">未配置渠道（推送渠道 Tab 配置）</span>
        )}
      </header>

      {draft === null ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => setDraft(draftOfGate(gate))}>
            编辑
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void toggleActive()}>
            {gate.isActive ? '停用' : '启用'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLogsOpen(!logsOpen)}>
            {logsOpen ? '收起派发历史' : '派发历史'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2 rounded-sm border border-border p-2">
          <div className="flex min-w-[200px] flex-col gap-1">
            <label htmlFor={`gate-name-${gate.id}`} className="text-xs text-muted-foreground">规则名</label>
            <Input
              id={`gate-name-${gate.id}`}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`gate-metric-${gate.id}`} className="text-xs text-muted-foreground">指标</label>
            <select
              id={`gate-metric-${gate.id}`}
              value={draft.metric}
              onChange={(e) => setDraft({ ...draft, metric: e.target.value as GateRuleDraft['metric'] })}
              className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
            >
              {GATE_METRICS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`gate-op-${gate.id}`} className="text-xs text-muted-foreground">条件</label>
            <select
              id={`gate-op-${gate.id}`}
              value={draft.op}
              onChange={(e) => setDraft({ ...draft, op: e.target.value as GateRuleDraft['op'] })}
              className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
            >
              {GATE_OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex w-[110px] flex-col gap-1">
            <label htmlFor={`gate-value-${gate.id}`} className="text-xs text-muted-foreground">阈值</label>
            <Input
              id={`gate-value-${gate.id}`}
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`gate-action-${gate.id}`} className="text-xs text-muted-foreground">动作</label>
            <select
              id={`gate-action-${gate.id}`}
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value as GateRuleDraft['action'] })}
              className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
            >
              {GATE_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <Button size="sm" onClick={() => void saveEdit()}>
            保存修改
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            取消
          </Button>
        </div>
      )}

      {error !== null ? (
        <p className="text-sm text-eval-fail" role="alert">
          {error}
        </p>
      ) : null}

      {logsOpen ? (
        <div className="flex flex-col gap-1 rounded-sm border border-border p-2">
          <p className="text-xs text-muted-foreground">
            派发历史（每次尝试一行，只追加不可改写；retryCount 当前恒为 0——无自动重试引擎）
          </p>
          {logs.data === null ? (
            <p className="text-xs text-muted-foreground" role="status">
              {logs.loading ? '加载中…' : (logs.error?.message ?? '暂无数据')}
            </p>
          ) : logs.data.items.length === 0 ? (
            <p className="text-xs text-muted-foreground" role="status">
              还没有派发记录（拉取门禁结果时才触发派发）。
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {logs.data.items.map((log) => (
                <DispatchLogRow key={log.id} log={log} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </article>
  );
}

function DispatchLogRow({ log }: { log: OutboundDispatchLog }): React.ReactElement {
  const errorLabel = dispatchErrorLabel(log);
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span
        className={`rounded-sm px-1.5 py-0.5 text-xs ${
          log.status === 'SUCCESS' ? 'bg-muted text-muted-foreground' : 'bg-eval-fail-bg text-eval-fail'
        }`}
      >
        {dispatchStatusLabel(log.status)}
      </span>
      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{log.channelKind}</span>
      <code className="truncate text-xs text-foreground">{log.channelUrl}</code>
      {errorLabel !== null ? (
        <span className="text-xs text-eval-fail">原因：{errorLabel}</span>
      ) : null}
      <span className="text-xs text-muted-foreground">{formatTimestamp(log.dispatchedAt)}</span>
    </li>
  );
}
