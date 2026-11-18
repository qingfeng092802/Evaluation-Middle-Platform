/**
 * PG-09「基线确认」Tab 的派生层（M4 收尾，`US-020` / `US-013`）。
 *
 * 角色语义（BL-1，需求方 2026-11-18 指令口径）：
 *  - `ROLE-A`（研发）：可见待审列表，**确认 / 驳回按钮 disabled**，提示「研发只可提名」；
 *  - `ROLE-B`（管理员）：按钮可点，走既有 decision 接口的 200 / 403 / 409 流转。
 * 服务端仍是唯一裁判（decision 路由非 B → 403）；这里只负责把语义渲染对。
 */
import type { Baseline, BaselineStatus } from '@eval-platform/contracts';
import type { PlatformRole } from './role.js';

export function baselineStatusLabel(status: BaselineStatus): string {
  return status === 'NOMINATED' ? '待确认' : status === 'CONFIRMED' ? '已确认' : '已驳回';
}

/** 确认 / 驳回能力（BL-1：仅 ROLE-B）。 */
export function canDecideBaseline(role: PlatformRole): boolean {
  return role === 'B';
}

/** ROLE-A 时按钮的禁用原因；ROLE-B 返回 null（不禁用）。 */
export function decideDisabledHint(role: PlatformRole): string | null {
  return canDecideBaseline(role) ? null : '研发只可提名（BL-1）；确认 / 驳回由 ROLE-B（管理员）操作';
}

/** Tab 头部的角色语义提示（两种角色文案可区分，供 UI 与测试锚定）。 */
export function roleHint(role: PlatformRole): string {
  return role === 'B'
    ? '当前角色 B（管理员）：可确认 / 驳回（接口流转 200 / 409）'
    : '当前角色 A（研发）：可提名基线；确认 / 驳回按钮禁用（BL-1）';
}

/**
 * decision 失败的可读解释（按错误码；400/403 直接透传服务端文案）。
 * 409 语义与数据库守卫一一对应：不可再裁（触发器）、双基线（部分唯一索引）。
 */
export function decisionFailureHint(code: string): string | null {
  if (code === 'IMMUTABLE_VIOLATION') return '该基线已被裁定过（CONFIRMED / REJECTED），留痕不可再改';
  if (code === 'CONFLICT') return '该评测集已有已确认基线（每集至多一个，BL-1）';
  return null;
}

/** 提名行要展示的运行名：优先 runSummary（JOIN 带出），缺省回退 run id。 */
export function baselineRunLabel(b: Baseline): string {
  return b.runSummary?.runName ?? b.evalRunId;
}
