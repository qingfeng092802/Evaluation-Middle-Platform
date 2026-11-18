'use client';

import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { Baseline, BaselineListResponse, DatasetListResponse } from '@eval-platform/contracts';
import { apiPost } from '@/lib/ui/client';
import { useApi } from '@/lib/ui/use-api';
import { Button } from '@/components/ui/button';
import { getRole, subscribeRole, type PlatformRole } from '@/lib/ui/role';

/** SSR 快照：服务端无 localStorage，恒为默认 A（与首帧渲染一致，防 hydration 抖动）。 */
const getServerRole = (): PlatformRole => 'A';
import { formatTimestamp } from '@/lib/format';
import {
  baselineRunLabel,
  baselineStatusLabel,
  canDecideBaseline,
  decisionFailureHint,
  decideDisabledHint,
  roleHint,
} from '@/lib/ui/baselines';

/**
 * `PG-09`「基线确认」Tab（M4 收尾，`US-020` / `US-013`）。
 *
 * 待审列表展示：运行名 / 提名理由 / 提名时间 / 状态。角色语义（BL-1）：
 *  - `ROLE-A`：列表可见，确认 / 驳回按钮 **disabled**，提示「研发只可提名」；
 *  - `ROLE-B`：按钮可点，走既有 decision 接口的 200 / 403 / 409 流转
 *    （服务端是唯一裁判——非 B 请求即使伪造 UI 也会被 403 挡下）。
 */
export function BaselinesSection(): React.ReactElement {
  const datasets = useApi(DatasetListResponse, '/api/datasets?limit=50');
  const [datasetId, setDatasetId] = React.useState<string>('');
  const baselines = useApi(
    BaselineListResponse,
    datasetId === '' ? null : `/api/baselines?datasetId=${datasetId}`,
  );
  const role = useSyncExternalStore(subscribeRole, getRole, getServerRole);
  const canDecide = canDecideBaseline(role);
  const disabledHint = decideDisabledHint(role);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const decide = async (b: Baseline, approve: boolean): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await apiPost(Baseline, `/api/baselines/${b.id}/decision`, { approve });
      setNotice(
        approve
          ? `已确认基线：${baselineRunLabel(b)}（该评测集此后退化对比以此为锚，BL-2）`
          : `已驳回提名：${baselineRunLabel(b)}`,
      );
      baselines.reload();
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      setError(decisionFailureHint(code) ?? (err as Error).message);
    }
  };

  const items = baselines.data?.items ?? [];
  const nominatedCount = items.filter((b) => b.status === 'NOMINATED').length;

  return (
    <section aria-labelledby="baselines-heading" className="flex flex-col gap-3">
      <h2 id="baselines-heading" className="text-sm font-medium text-muted-foreground">
        基线确认（确认后成为该评测集退化对比的唯一锚点）
      </h2>
      <p className="text-xs text-muted-foreground">{roleHint(role)}</p>

      <div className="flex flex-col gap-1">
        <label htmlFor="baselines-dataset" className="text-xs text-muted-foreground">选择评测集</label>
        <select
          id="baselines-dataset"
          value={datasetId}
          onChange={(e) => {
            setDatasetId(e.target.value);
            setError(null);
            setNotice(null);
          }}
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
          选择一个评测集以查看其基线提名。
        </p>
      ) : baselines.loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          加载中…
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          该评测集还没有基线提名——研发可在运行详情页提名（US-013）。
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            待确认提名 {nominatedCount} 条 / 共 {items.length} 条
          </p>
          <ul className="flex flex-col gap-2">
            {items.map((b) => {
              return (
                <li
                  key={b.id}
                  className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
                >
                  <header className="flex flex-wrap items-center gap-2">
                    <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {baselineStatusLabel(b.status)}
                    </span>
                    <span className="text-sm font-semibold text-foreground">{baselineRunLabel(b)}</span>
                    <span className="text-xs text-muted-foreground">
                      提名时间：{formatTimestamp(b.nominatedAt)}
                    </span>
                  </header>
                  <p className="text-sm text-foreground">
                    提名理由：{b.note ?? '（未填写）'}
                  </p>
                  {b.status === 'NOMINATED' ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={!canDecide}
                        title={disabledHint ?? undefined}
                        onClick={() => void decide(b, true)}
                      >
                        确认
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canDecide}
                        title={disabledHint ?? undefined}
                        onClick={() => void decide(b, false)}
                      >
                        驳回
                      </Button>
                      {!canDecide ? (
                        <span className="text-xs text-muted-foreground">{disabledHint}</span>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      裁定人 {b.decidedBy ?? '—'} · {formatTimestamp(b.decidedAt)}
                      {b.status === 'REJECTED' && b.note !== null ? ` · 驳回理由：${b.note}` : ''}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

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
    </section>
  );
}
