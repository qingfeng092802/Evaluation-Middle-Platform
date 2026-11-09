'use client';

import * as React from 'react';
import type { RunPreflight } from '@eval-platform/contracts';
import { DatasetListResponse, DatasetVersionListResponse, RunPreflight as RunPreflightSchema } from '@eval-platform/contracts';
import { apiGet } from './client';

/**
 * `PG-01`「未配置模型网关凭证」横幅的数据源（`[FE-03]` 交付物 1）。
 *
 * 为什么不直接调 `/api/runs/preflight`：该接口的 `RunPreflightQuery` 要求
 * `datasetVersionId`，而运行台列表页**还没有选择任何版本**。
 *
 * 也不新开一个「只回凭证状态」的端点：那等于在服务端复制一份 `hasProviderCredentials`
 * 的判定逻辑，两份口径迟早不一致。凭证的唯一事实源是 `model_providers.is_active`，
 * 而它已经由 `/api/runs/preflight` 透出。
 *
 * 因此做法是**用最新版本探一次**：最新评测集 → 它的最新版本 → 该版本的 preflight。
 * 库里还没有评测集/版本时返回 `null` —— 此时页面本来就是空状态，
 * 再叠一条「没配凭证」只会让首屏出现两个互相竞争的告警。
 */
export async function fetchNewestVersionPreflight(): Promise<RunPreflight | null> {
  const datasets = await apiGet(DatasetListResponse, '/api/datasets?limit=1');
  const dataset = datasets.items[0];
  if (dataset === undefined || dataset.latestVersionNo === null) return null;

  const versions = await apiGet(
    DatasetVersionListResponse,
    `/api/datasets/${dataset.id}/versions`,
  );
  const version = versions.items.find((v) => v.versionNo === dataset.latestVersionNo);
  if (version === undefined) return null;

  return apiGet(RunPreflightSchema, `/api/runs/preflight?datasetVersionId=${version.id}`);
}

export interface ProviderStatus {
  /** 探测结果；未探到（无版本 / 请求失败）时为 `null`。 */
  readonly preflight: RunPreflight | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * 三态包装。
 *
 * 探测失败时把 `preflight` 置 `null` 而不是伪造 `hasProviderCredentials: false`：
 * 网络抖动不该被渲染成「你没配凭证」——那会把用户引向一个完全无关的修复动作。
 */
export function useProviderStatus(): ProviderStatus {
  const [preflight, setPreflight] = React.useState<RunPreflight | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchNewestVersionPreflight()
      .then((p) => {
        if (alive) setPreflight(p);
      })
      .catch(() => {
        if (alive) setPreflight(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const reload = React.useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  return { preflight, loading, reload };
}
