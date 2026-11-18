/**
 * PR → 评测集触发规则服务（M5，Q6：绑定 PR 专用冒烟集）。
 * 校验/身份口径与 baselines / gates 一致（LOCAL_ACTOR，OUT-4）。
 */
import { PrTriggerRuleCreate, Uuid } from '@eval-platform/contracts';
import type { PrTriggerRule } from '@eval-platform/contracts';
import {
  createTriggerRule as repoCreateTriggerRule,
  listTriggerRulesByIntegration,
} from '../../../db/repo/githubIntegrations.js';

/** MVP 单机标识（与 baselines / gates 同口径，OUT-4 不做用户体系）。 */
const LOCAL_ACTOR = 'local';

export async function createTriggerRule(raw: unknown): Promise<PrTriggerRule> {
  const input = PrTriggerRuleCreate.parse(raw);
  return repoCreateTriggerRule({
    integrationId: input.integrationId,
    repoFullName: input.repoFullName,
    targetBranch: input.targetBranch ?? null,
    pathGlobs: input.pathGlobs ?? null,
    label: input.label ?? null,
    datasetId: input.datasetId,
    targetId: input.targetId ?? null,
    createdBy: LOCAL_ACTOR,
  });
}

export async function listTriggerRules(integrationIdRaw: string | null): Promise<{
  items: PrTriggerRule[];
  page: { nextCursor: null; total: number };
}> {
  const integrationId = Uuid.parse(integrationIdRaw);
  const items = await listTriggerRulesByIntegration(integrationId);
  return { items, page: { nextCursor: null, total: items.length } };
}
