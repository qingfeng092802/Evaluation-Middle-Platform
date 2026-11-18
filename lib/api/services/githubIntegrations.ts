/**
 * GitHub 集成配置服务（M5 Batch 2，`US-022`）。
 *
 * **凭据非对称在这里收口**：明文（PEM / webhook_secret）只进 `createIntegration` /
 * `updateIntegration` 的写路径，两个读取函数返回的形状里只有布尔位——
 * `GithubIntegration` 契约的 shape 本身不含凭据键（泄密扫描双保险：
 * `tests/github-contract-leak.spec.ts` 契约层 + `webhook-inbound.spec.ts` API 级）。
 */
import { GithubIntegrationCreate, GithubIntegrationUpdate, Uuid } from '@eval-platform/contracts';
import type { GithubIntegration } from '@eval-platform/contracts';
import { NotFoundError } from '../http.js';
import {
  createIntegration as repoCreateIntegration,
  getIntegrationRow,
  listIntegrationViews,
  updateIntegration as repoUpdateIntegration,
} from '../../../db/repo/githubIntegrations.js';

/** MVP 单机标识（与 baselines / gates 同口径，OUT-4 不做用户体系）。 */
const LOCAL_ACTOR = 'local';

export async function createIntegration(raw: unknown): Promise<GithubIntegration> {
  const input = GithubIntegrationCreate.parse(raw);
  return repoCreateIntegration({
    name: input.name,
    appId: input.appId,
    installationId: input.installationId,
    privateKey: input.privateKey,
    webhookSecret: input.webhookSecret,
    repos: input.repos,
    createdBy: LOCAL_ACTOR,
  });
}

export async function listIntegrations(): Promise<{
  items: GithubIntegration[];
  page: { nextCursor: null; total: number };
}> {
  const items = await listIntegrationViews();
  return { items, page: { nextCursor: null, total: items.length } };
}

export async function getIntegration(idRaw: string | null): Promise<GithubIntegration> {
  const id = Uuid.parse(idRaw);
  const view = await getIntegrationRow(id);
  if (!view) throw new NotFoundError('GitHub 集成不存在');
  return view;
}

export async function updateIntegration(idRaw: string, raw: unknown): Promise<GithubIntegration> {
  const id = Uuid.parse(idRaw);
  const patch = GithubIntegrationUpdate.parse(raw);
  const view = await repoUpdateIntegration(id, patch);
  if (!view) throw new NotFoundError('GitHub 集成不存在');
  return view;
}
