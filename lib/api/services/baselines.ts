/**
 * Baseline 提名 / 解析（M3 Batch 1，`US-013`；decision 在裁定落定后接入）。
 *
 * ## 实现前提（需求方 2026-11-15 裁定，非本文件自创）
 *
 * - **角色**：MVP 阶段由 `X-Role: A|B` 请求头模拟（缺省 `A`）。提名是 ROLE-A 能力，
 *   此处不做角色拦截；`decision` 路由仅 ROLE-B，非 B → 403。
 * - **身份**：`nominated_by` / `decided_by` 写固定单机标识 `'local'` —— MVP 占位值
 *   （OUT-4 不做用户体系；PG-09 待审列表只展示运行名 / 理由 / 时间，不展示它）。
 *   勿为它虚构身份表。
 * - **守卫（fail-closed，裁定 3）**：非 `COMPLETED` / `PARTIAL_FAILED` 的 run 提名
 *   → 409；同一 run 重复提名 → 409；已有 CONFIRMED 基线时提名**仍允许**（进待审
 *   队列），唯一性由确认时的 `ux_baselines_one_confirmed` 报 409 兜底。
 * - `datasetId` 与 run 实际所属评测集不匹配 → 400（请求体语义自相矛盾，属脏输入）。
 */
import { BaselineDecision, BaselineNominate, BaselineStatus, Uuid } from '@eval-platform/contracts';
import type { Baseline, BaselineResolution } from '@eval-platform/contracts';
import { BadRequestError, ConflictError, NotFoundError } from '../http.js';
import {
  datasetExists,
  decideBaseline as repoDecideBaseline,
  findBaselineIdByRun,
  getBaselineResolution,
  getBaselineRow,
  getRunNominationContext,
  insertBaseline,
  listBaselines as repoListBaselines,
} from '../../../db/repo/baselines.js';

/** MVP 单机标识（裁定 2）。有真实身份体系时再演进，勿提前发明。 */
const LOCAL_ACTOR = 'local';

export async function nominateBaseline(raw: unknown): Promise<Baseline> {
  const input = BaselineNominate.parse(raw);
  const run = await getRunNominationContext(input.evalRunId);
  if (!run) throw new NotFoundError('评测运行不存在');
  if (run.datasetId !== input.datasetId) {
    throw new BadRequestError('evalRunId 与 datasetId 不属于同一评测集', {
      datasetId: input.datasetId,
      runDatasetId: run.datasetId,
    });
  }
  if (run.status !== 'COMPLETED' && run.status !== 'PARTIAL_FAILED') {
    throw new ConflictError(`仅 COMPLETED / PARTIAL_FAILED 的运行可提名（当前 ${run.status}）`);
  }
  if (await findBaselineIdByRun(input.evalRunId)) {
    throw new ConflictError('该运行已提名过，不能重复提名');
  }
  return insertBaseline({
    datasetId: input.datasetId,
    evalRunId: input.evalRunId,
    note: input.note,
    nominatedBy: LOCAL_ACTOR,
  });
}

export async function resolveBaseline(datasetIdRaw: string | null): Promise<BaselineResolution> {
  const datasetId = Uuid.parse(datasetIdRaw);
  const res = await getBaselineResolution(datasetId);
  if (!res) throw new NotFoundError('评测集不存在');
  return { datasetId, confirmed: res.confirmed, pendingNominations: res.pendingNominations };
}

/**
 * 基线列表（PG-09「基线确认」Tab 数据面；`GET /api/baselines`）。
 * 评测集不存在 → 404；`status` 缺省不过滤（openapi 已先行定义该参数，枚举由契约校验）。
 */
export async function listBaselines(
  datasetIdRaw: string | null,
  statusRaw: string | null,
): Promise<{ items: Baseline[]; page: { nextCursor: null; total: number } }> {
  const datasetId = Uuid.parse(datasetIdRaw);
  if (!(await datasetExists(datasetId))) throw new NotFoundError('评测集不存在');
  const status = statusRaw === null ? null : BaselineStatus.parse(statusRaw);
  const items = await repoListBaselines(datasetId, status);
  return { items, page: { nextCursor: null, total: items.length } };
}

/**
 * 确认 / 驳回（`US-020`）。角色拦截在 decision 路由（裁定 1，403）；
 * 本层只管：基线不存在 → 404；流转合法性交给 `trg_baselines_guard`、
 * 双基线交给 `ux_baselines_one_confirmed`（两者都由 `handle()` 翻译成 409）。
 * note 语义（裁定 2）：payload 携带则覆盖，未携带则保留提名理由。
 */
export async function decideBaseline(baselineId: string, raw: unknown): Promise<Baseline> {
  const decision = BaselineDecision.parse(raw);
  const current = await getBaselineRow(baselineId);
  if (!current) throw new NotFoundError('基线不存在');
  return repoDecideBaseline({
    id: baselineId,
    approve: decision.approve,
    decidedBy: LOCAL_ACTOR,
    ...(decision.note === undefined ? {} : { note: decision.note }),
  });
}
