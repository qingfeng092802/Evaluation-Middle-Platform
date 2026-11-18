'use client';

import * as React from 'react';
import {
  CallbackTokenResponse,
  DatasetListResponse,
  RegressionGate,
  RegressionGateListResponse,
} from '@eval-platform/contracts';
import type { GateChannel } from '@eval-platform/contracts';
import { apiPatch, apiPost } from '@/lib/ui/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/ui/use-api';
import {
  CHANNEL_KINDS,
  channelsSummaryOf,
  closeTokenOnce,
  openTokenOnce,
  withChannel,
  withoutChannel,
  type TokenOnceState,
} from '@/lib/ui/channels';

/**
 * `PG-09`「推送渠道」Tab（M4 Batch 4，`US-018`）。
 *
 * 按评测集列门禁规则；每条规则管理自己的出站渠道（飞书/企微/通用 Webhook）
 * 与回调 Token。**Token 明文只显示一次**（`US-018`）：签发响应即唯一可见机会，
 * 关闭面板后只能重置（重新签发）。
 */
export function ChannelsSection(): React.ReactElement {
  const datasets = useApi(DatasetListResponse, '/api/datasets?limit=50');
  const [datasetId, setDatasetId] = React.useState<string>('');
  const gates = useApi(RegressionGateListResponse, datasetId === '' ? null : `/api/gates?datasetId=${datasetId}`);

  return (
    <section aria-labelledby="channels-heading" className="flex flex-col gap-3">
      <h2 id="channels-heading" className="text-sm font-medium text-muted-foreground">
        推送渠道（评测结束后把结论推送到配置的渠道；CI 拉取结果需回调 Token）
      </h2>

      <div className="flex flex-col gap-1">
        <label htmlFor="channels-dataset" className="text-xs text-muted-foreground">选择评测集</label>
        <select
          id="channels-dataset"
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
          选择一个评测集以查看其门禁规则的推送配置。
        </p>
      ) : gates.loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          加载中…
        </p>
      ) : (gates.data?.items ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          该评测集还没有门禁规则——先在「发起评测」流程或 API 里配置规则。
        </p>
      ) : (
        (gates.data?.items ?? []).map((g) => (
          <GateChannelsCard
            key={g.id}
            gate={g}
            onChanged={() => {
              gates.reload();
            }}
          />
        ))
      )}
    </section>
  );
}

function GateChannelsCard({ gate, onChanged }: { gate: RegressionGate; onChanged: () => void }): React.ReactElement {
  const [kind, setKind] = React.useState<GateChannel['kind']>('webhook');
  const [url, setUrl] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [tokenOnce, setTokenOnce] = React.useState<TokenOnceState>({ revealedToken: null, gateId: null });

  const addChannel = async (): Promise<void> => {
    setError(null);
    if (url.trim() === '') {
      setError('请填写渠道 URL');
      return;
    }
    try {
      await apiPatch(RegressionGate, `/api/gates/${gate.id}`, {
        channels: withChannel(gate.channels, { kind, url: url.trim() }),
      });
      setUrl('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeChannel = async (ch: GateChannel): Promise<void> => {
    setError(null);
    try {
      await apiPatch(RegressionGate, `/api/gates/${gate.id}`, { channels: withoutChannel(gate.channels, ch) });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const issueToken = async (): Promise<void> => {
    setError(null);
    try {
      const res = await apiPost(CallbackTokenResponse, `/api/gates/${gate.id}/callback-token`, {});
      setTokenOnce(openTokenOnce(tokenOnce, gate.id, res.token));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const condition = gate.condition;
  const conditionLabel = `${condition.metric} ${condition.op} ${condition.value}`;

  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{gate.name}</h3>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">{gate.action}</span>
        <code className="text-xs text-muted-foreground">{conditionLabel}</code>
        {channelsSummaryOf(gate) !== '' ? (
          <span className="text-xs text-muted-foreground">渠道：{channelsSummaryOf(gate)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">未配置渠道</span>
        )}
      </header>

      {gate.channels.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {gate.channels.map((ch, i) => (
            <li key={`${ch.kind}-${ch.url}-${i}`} className="flex items-center gap-2 text-sm">
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {CHANNEL_KINDS.find((c) => c.value === ch.kind)?.label ?? ch.kind}
              </span>
              <code className="truncate text-xs text-foreground">{ch.url}</code>
              <Button size="sm" variant="ghost" onClick={() => void removeChannel(ch)}>
                移除
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`ch-kind-${gate.id}`} className="text-xs text-muted-foreground">渠道类型</label>
          <select
            id={`ch-kind-${gate.id}`}
            value={kind}
            onChange={(e) => setKind(e.target.value as GateChannel['kind'])}
            className="h-9 rounded-sm border border-input bg-card px-2 text-sm text-foreground"
          >
            {CHANNEL_KINDS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <label htmlFor={`ch-url-${gate.id}`} className="text-xs text-muted-foreground">Webhook URL</label>
          <Input id={`ch-url-${gate.id}`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        <Button size="sm" variant="secondary" onClick={() => void addChannel()}>
          添加渠道
        </Button>
        <Button size="sm" variant="outline" onClick={() => void issueToken()}>
          生成回调 Token
        </Button>
      </div>

      {error !== null ? (
        <p className="text-sm text-eval-fail" role="alert">
          {error}
        </p>
      ) : null}

      {tokenOnce.gateId === gate.id && tokenOnce.revealedToken !== null ? (
        <div className="flex flex-col gap-1 rounded-md border border-eval-warn-mark bg-eval-warn-bg p-3">
          <p className="text-xs font-medium text-foreground">
            回调 Token 明文（**只显示这一次**——关闭后只能重新签发；平台只存 SHA-256 哈希）：
          </p>
          <code className="break-all text-xs text-foreground">{tokenOnce.revealedToken}</code>
          <div className="self-end">
            <Button size="sm" variant="ghost" onClick={() => setTokenOnce(closeTokenOnce(tokenOnce))}>
              我已保存，关闭
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
