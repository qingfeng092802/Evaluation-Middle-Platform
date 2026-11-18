/**
 * PG-09「门禁规则」Tab 的派生层（M4 收尾，`US-017`）。
 *
 * 与 `lib/ui/providers.ts` 同一惯例：**表单派生 / 校验 / 请求体形状全部在这里**，
 * 页面组件只做渲染与状态；每个函数都是纯函数，单测直测（settings-tabs-ui.spec）。
 *
 * 角色语义：门禁规则配置是 `ROLE-B` 能力（`US-017` 原文「作为 ROLE-B，我希望配置
 * 门禁规则」）；`ROLE-A` 只读——列表可见、新建 / 编辑控件禁用并给出指引
 * （可见性口径为需求方 2026-11-18 指令：A 可见、操作禁用；与 `pages-and-flows.md`
 * PG-09「仅 ROLE-B 可见」的字句差异由需求方拍板，见阶段报告）。
 */
import type { GateAction, GateCondition, GateMetric, RegressionGate } from '@eval-platform/contracts';
import type { PlatformRole } from './role.js';

export const GATE_METRICS: ReadonlyArray<{ readonly value: GateMetric; readonly label: string }> = [
  { value: 'score_overall', label: '总分 score_overall' },
  { value: 'pass_rate', label: '通过率 pass_rate' },
  { value: 'regression_pct', label: '退化率 regression_pct（相对已确认基线）' },
];

export const GATE_OPS: ReadonlyArray<{ readonly value: '<' | '>'; readonly label: string }> = [
  { value: '<', label: '低于（触发）' },
  { value: '>', label: '高于（触发）' },
];

export const GATE_ACTIONS: ReadonlyArray<{ readonly value: GateAction; readonly label: string }> = [
  { value: 'BLOCK', label: '阻断 BLOCK' },
  { value: 'WARN', label: '仅告警 WARN' },
];

/** 表单草稿：`value` 保留输入框原始字符串，提交时才解析（不把 NaN 塞进契约）。 */
export interface GateRuleDraft {
  readonly name: string;
  readonly metric: GateMetric;
  readonly op: '<' | '>';
  readonly value: string;
  readonly action: GateAction;
}

export const EMPTY_GATE_DRAFT: GateRuleDraft = {
  name: '',
  metric: 'score_overall',
  op: '<',
  value: '0.85',
  action: 'BLOCK',
};

/** 编辑预填：契约值 → 草稿字符串。 */
export function draftOfGate(gate: RegressionGate): GateRuleDraft {
  return {
    name: gate.name,
    metric: gate.condition.metric,
    op: gate.condition.op,
    value: String(gate.condition.value),
    action: gate.action,
  };
}

/** 表单校验：返回第一个错误文案；合法返回 null（与 `providerFormError` 同惯例）。 */
export function gateFormError(draft: GateRuleDraft): string | null {
  if (draft.name.trim() === '') return '规则名不可为空';
  if (draft.value.trim() === '' || Number.isNaN(Number(draft.value))) return '阈值必须是数字';
  const value = Number(draft.value);
  if (draft.metric === 'regression_pct') {
    if (value < 0) return '退化率阈值不得为负（契约 refine 同口径）';
  } else if (value < 0 || value > 1) {
    return '绝对指标（score_overall / pass_rate）的阈值必须落在 [0,1]';
  }
  return null;
}

/** `POST /api/gates` 请求体（形状由契约在服务端兜底；此处已保证 value 为 number）。 */
export function gateCreateBody(draft: GateRuleDraft, datasetId: string): {
  name: string;
  datasetId: string;
  condition: GateCondition;
  action: GateAction;
} {
  return {
    name: draft.name.trim(),
    datasetId,
    condition: { metric: draft.metric, op: draft.op, value: Number(draft.value) },
    action: draft.action,
  };
}

/**
 * `PATCH /api/gates/{id}` 请求体——**只发改动的三件**（name / condition / action）。
 * 契约「不传即不改」：`channels` / `isActive` / `baselineId` 走各自的专用控件，
 * 编辑表单绝不顺手把它们重置。
 */
export function gateUpdateBody(draft: GateRuleDraft): {
  name: string;
  condition: GateCondition;
  action: GateAction;
} {
  return {
    name: draft.name.trim(),
    condition: { metric: draft.metric, op: draft.op, value: Number(draft.value) },
    action: draft.action,
  };
}

/** 规则卡上的条件摘要，如 `score_overall < 0.85`。 */
export function conditionLabel(condition: GateCondition): string {
  return `${condition.metric} ${condition.op} ${condition.value}`;
}

export function gateActiveLabel(isActive: boolean): string {
  return isActive ? '启用' : '停用';
}

/** 门禁规则配置能力（`US-017`：ROLE-B）。 */
export function canManageGates(role: PlatformRole): boolean {
  return role === 'B';
}

export function manageGatesDisabledHint(role: PlatformRole): string | null {
  return canManageGates(role) ? null : '门禁规则配置仅 ROLE-B（US-017）；当前为只读视图';
}

// ---------------------------------------------------------------------------
// 派发历史（0021）行标签
// ---------------------------------------------------------------------------

export function dispatchStatusLabel(status: 'SUCCESS' | 'FAILED'): string {
  return status === 'SUCCESS' ? '成功' : '失败';
}

/** 失败原因文案：FAILED 行必有 errorMessage（数据库 CHECK 强制），此函数兜底空串。 */
export function dispatchErrorLabel(log: {
  readonly status: 'SUCCESS' | 'FAILED';
  readonly errorMessage: string | null;
}): string | null {
  return log.status === 'FAILED' ? (log.errorMessage ?? '未知原因') : null;
}
