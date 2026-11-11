/**
 * 待测目标服务层（`PG-06`）。
 *
 * 版本语义只在这里解释一次：**`config` 变化才推版本号，名称变化只改容器**。
 * 仓储层负责深比较，本层负责把结果翻译成用户看得懂的话
 * （「保存后将生成 v2，历史运行仍引用 v1」）。
 */
import type { Target, TargetVersion } from '@eval-platform/contracts';
import { TARGET_T2_ENABLED, TargetCreate, TargetUpdate } from '@eval-platform/contracts';
import {
  createTarget as repoCreateTarget,
  getTarget,
  getVersionById,
  listTargets as repoListTargets,
  listVersions as repoListVersions,
  updateTarget as repoUpdateTarget,
} from '../../../db/repo/targets.js';
import { BadRequestError, NotFoundError } from '../http.js';

const CREATED_BY = process.env['APP_CREATED_BY'] ?? 'm1-local';

/** P0 期 T2 明确不可用：在 API 层就拒，而不是靠前端把选项置灰。 */
function rejectT2IfDisabled(kind: string): void {
  if (kind === 't2_http' && !TARGET_T2_ENABLED) {
    throw new BadRequestError('T2（外部 HTTP 回调）为 P1 能力，M1 仅支持 T1 Prompt 目标', {
      kind,
      t2Enabled: TARGET_T2_ENABLED,
    });
  }
}

export async function listTargetPage(limit: number): Promise<Target[]> {
  return repoListTargets(limit);
}

export async function getTargetOrThrow(id: string): Promise<Target> {
  const t = await getTarget(id);
  if (!t) throw new NotFoundError('待测目标不存在');
  return t;
}

export async function createTarget(raw: unknown): Promise<Target> {
  const body = TargetCreate.parse(raw);
  rejectT2IfDisabled(body.config.kind);
  return repoCreateTarget({ name: body.name, config: body.config, createdBy: CREATED_BY });
}

export interface TargetUpdateOutcome {
  readonly target: Target;
  /** `null` ⇒ 只改了名称，版本号未变（前端不该弹「已生成 v2」）。 */
  readonly newVersionNo: number | null;
}

export async function updateTarget(id: string, raw: unknown): Promise<TargetUpdateOutcome> {
  const body = TargetUpdate.parse(raw);
  if (body.config) rejectT2IfDisabled(body.config.kind);

  const result = await repoUpdateTarget({
    id,
    name: body.name,
    config: body.config,
    updatedBy: CREATED_BY,
  });
  if (result.kind === 'not_found') throw new NotFoundError('待测目标不存在');
  return { target: result.target, newVersionNo: result.newVersionNo };
}

export async function listTargetVersions(targetId: string): Promise<TargetVersion[]> {
  await getTargetOrThrow(targetId);
  return repoListVersions(targetId);
}

export async function getTargetVersionOrThrow(versionId: string): Promise<TargetVersion> {
  const v = await getVersionById(versionId);
  if (!v) throw new NotFoundError('待测目标版本不存在');
  return v;
}
