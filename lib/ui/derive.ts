/**
 * 前端展示口径的**判断**层（纯函数，无 React 依赖）。
 *
 * 为什么把这几条从组件里抽出来：
 * 「`FAILED` 时 `coverage` 提到主位」「缺失分数显示 `—` 而不是 `0`」「空态文案逐字取自
 * `pages-and-flows.md` §5」——这些是**产品口径**，不是样式。放在 JSX 里就只能靠人眼验收；
 * 放在这里可以被单测逐字锁死，改一个字就红。
 *
 * 本文件不 import 任何组件、不读写 DOM、不发起请求。
 */
import type { RunStatus } from '@eval-platform/contracts';
import { formatScore } from '../format/index.js';

/** 状态语义档。与 `DESIGN.md` §4.4 的 Token 分组一一对应。 */
export type StatusTone = 'muted' | 'running' | 'pass' | 'warn' | 'fail';

const STATUS_TEXT: Readonly<Record<RunStatus, string>> = {
  PENDING: '待执行',
  RUNNING: '运行中',
  COMPLETED: '已完成',
  PARTIAL_FAILED: '部分失败',
  FAILED: '失败',
  CANCELLED: '已中止',
};

const STATUS_TONE: Readonly<Record<RunStatus, StatusTone>> = {
  PENDING: 'muted',
  RUNNING: 'running',
  COMPLETED: 'pass',
  PARTIAL_FAILED: 'warn',
  FAILED: 'fail',
  CANCELLED: 'muted',
};

/** `RS-01`…`RS-06` 文案。事实源：`pages-and-flows.md` §4.1。 */
export function describeRunStatus(status: RunStatus): string {
  return STATUS_TEXT[status];
}

export function runStatusTone(status: RunStatus): StatusTone {
  return STATUS_TONE[status];
}

/**
 * `DESIGN.md` §4.4「图标」列的 Lucide 名。
 *
 * 返回**名字字符串**而不是组件：`lib/` 不许依赖 React/图标库，
 * 组件层再拿这张表去查 `lucide-react` 的导出。这样图标名也能被单测锁死
 * （Lucide 跨大版本改过名，`AlertTriangle` → `TriangleAlert`）。
 */
export type RunStatusIconName =
  | 'Clock'
  | 'Loader'
  | 'CircleCheck'
  | 'TriangleAlert'
  | 'CircleX'
  | 'CircleSlash';

const STATUS_ICON: Readonly<Record<RunStatus, RunStatusIconName>> = {
  PENDING: 'Clock',
  RUNNING: 'Loader',
  COMPLETED: 'CircleCheck',
  PARTIAL_FAILED: 'TriangleAlert',
  FAILED: 'CircleX',
  CANCELLED: 'CircleSlash',
};

export function runStatusIcon(status: RunStatus): RunStatusIconName {
  return STATUS_ICON[status];
}

/**
 * 是否带呼吸脉冲。
 *
 * 只有 `RUNNING` 有（`DESIGN.md` §4.4「呼吸脉冲」）。这是全站仅有的两个动效之一，
 * 不能顺手给其它状态加 —— 静息页面上的跳动会持续抢注意力。
 */
export function runStatusAnimated(status: RunStatus): boolean {
  return status === 'RUNNING';
}

/** `PG-03` 指标卡的主位指标。 */
export type PrimaryMetric = 'scoreOverall' | 'coverage';

/**
 * `FAILED` 时 `score_overall` 恒为 `NULL`（数据库 `ck_eval_runs_failed_null_score` 强制），
 * 继续把它放主位就只剩一个「—」。此时用户真正想知道的是「跑成了几条」，
 * 所以把 `coverage` 提到主位（`SPEC-M1` `[FE-03]` DoD）。
 */
export function primaryMetricOf(status: RunStatus): PrimaryMetric {
  return status === 'FAILED' ? 'coverage' : 'scoreOverall';
}

/**
 * 分数单元格。
 *
 * `null` 一律 `—`：`FAILED` 的 `score_overall`、无 `passThreshold` 的 `pass_rate`
 * 都是 `NULL`。渲染成 `0` 会让「没算出来」看起来像「考了 0 分」。
 */
export function scoreCell(value: number | null | undefined, _status: RunStatus): string {
  return value === null || value === undefined ? '—' : formatScore(value);
}

// ---------------------------------------------------------------------------
// 空态 / 固定文案
// ---------------------------------------------------------------------------

/** 空态与固定提示的键。每个键对应 `pages-and-flows.md` / `DESIGN.md` 的一处原文。 */
export type EmptyStateKey =
  | 'runs'
  | 'datasets'
  | 'targets'
  | 'datasetUpload'
  | 'datasetVersionFrozen'
  | 'noReference'
  | 'noBaseline'
  | 'noProviderCredentials'
  | 'blockedNoRetrieval'
  | 'blockedNoEvaluators'
  | 'blockedNoCredentials'
  | 'targetVersionHint'
  | 'reproducibilityNotice';

export interface EmptyStateAction {
  readonly label: string;
  readonly href: string;
}

export interface EmptyState {
  readonly message: string;
  readonly actions: readonly EmptyStateAction[];
}

/**
 * 原文对照表。
 *
 * ⚠️ **这些字符串是产品口径，不得改写、不得润色、不得加标点**。
 * `OPEN-4` 锁死句尤其如此：改成「可复现」就是对用户的谎言。
 */
const EMPTY_STATES: Readonly<Record<EmptyStateKey, EmptyState>> = {
  runs: {
    message: '还没有评测记录。',
    actions: [
      { label: '去导入评测集', href: '/datasets' },
      { label: '去创建待测目标', href: '/targets' },
    ],
  },
  datasets: { message: '还没有评测集。', actions: [] },
  targets: { message: '还没有待测目标。', actions: [] },
  datasetUpload: { message: '没有可导入的有效记录，请检查文件格式。', actions: [] },
  datasetVersionFrozen: {
    message: '版本 v3 已发布，不可修改。如需调整数据，请导入并生成新版本。',
    actions: [],
  },
  noReference: { message: '本条未提供参考答案', actions: [] },
  noBaseline: { message: '暂无基线，仅显示本次输出', actions: [] },
  noProviderCredentials: { message: '尚未配置模型网关凭证，无法发起评测。', actions: [] },
  blockedNoRetrieval: {
    message: '当前数据集版本没有检索标注，无法计算 Recall@K。请更换版本或移除该算子。',
    actions: [],
  },
  blockedNoEvaluators: { message: '请至少配置一个评测算子。', actions: [] },
  blockedNoCredentials: { message: '尚未配置模型网关凭证，无法发起评测。', actions: [] },
  targetVersionHint: { message: '保存后将生成 v2，历史运行仍引用 v1', actions: [] },
  reproducibilityNotice: { message: 'EvalRun 可解释，不可复现。', actions: [] },
};

export function emptyState(key: EmptyStateKey): EmptyState {
  return EMPTY_STATES[key];
}

/**
 * `PG-02` 的阻塞码 → 文案键。
 *
 * 后端返回的 `BLOCKED_*` 码是稳定契约，文案是展示层的事；
 * 在这里做唯一一次映射，避免三个页面各写一份 `switch` 然后漂移。
 */
export function blockerText(
  code: 'BLOCKED_NO_PROVIDER_CREDENTIALS' | 'BLOCKED_NO_EVALUATORS' | 'BLOCKED_NO_RETRIEVAL_ANNOTATION',
): EmptyState {
  switch (code) {
    case 'BLOCKED_NO_PROVIDER_CREDENTIALS':
      return EMPTY_STATES.blockedNoCredentials;
    case 'BLOCKED_NO_EVALUATORS':
      return EMPTY_STATES.blockedNoEvaluators;
    case 'BLOCKED_NO_RETRIEVAL_ANNOTATION':
      return EMPTY_STATES.blockedNoRetrieval;
  }
}

// ---------------------------------------------------------------------------
// 占位页（`SPEC-M1` §6.5 `T-3`，需求方 2026-11-10「方案 A」裁定）
// ---------------------------------------------------------------------------

/** 占位页的键。每个键对应 `pages-and-flows.md` 里一个**不在 M1** 的页面。 */
export type PlaceholderKey = 'pg07' | 'pg08' | 'pg09';

export interface PlaceholderNotice {
  /** 需求文档里的页面编号，用户能对上 `pages-and-flows.md`。 */
  readonly pageId: string;
  /** 页面名，与侧栏 / 需求文档一致。 */
  readonly title: string;
  /** 里程碑归属。`pg09` 是两段（M2 模型网关 Tab / M4 门禁规则 Tab），故为字符串。 */
  readonly milestone: string;
  /** 主文案。必须含「上线」二字，说清是「还没到」而不是「坏了」。 */
  readonly message: string;
  /** 为什么 M1 不做 —— 一句实话，避免用户以为是遗漏。 */
  readonly reason: string;
  /** 现在能去哪里做类似的事（不留死胡同）。 */
  readonly fallback: { readonly label: string; readonly href: string };
}

/**
 * 三个占位页的原文。
 *
 * ⚠️ `milestone` 的取值**逐条对齐** `SPEC-M1` §1.1 与「M1 → M2 拆除清单」：
 * `PG-08` → M3、`PG-07` → M4、`PG-09` → M2（模型网关）/ M4（门禁规则）。
 * 改这里等于改对用户的承诺，先改 SPEC。
 */
export const PLACEHOLDER_NOTICES: Readonly<Record<PlaceholderKey, PlaceholderNotice>> = {
  pg08: {
    pageId: 'PG-08',
    title: '报告对比',
    milestone: 'M3',
    message: '报告对比功能将在 M3 上线。',
    reason:
      '双版本对比依赖「已确认基线」，基线确认与门禁裁决在 M3 随 US-009 / US-020 一起交付；当前 Milestone 1 没有对比接口。',
    fallback: { label: '回到评测运行台', href: '/runs' },
  },
  pg07: {
    pageId: 'PG-07',
    title: '算子库',
    milestone: 'M4',
    message: '独立算子库页面将在 M4 上线。',
    reason:
      'M1 的六个内置确定性算子直接内联在「发起评测」第 3 步里配置，不需要独立页面；全局模板库属 US-016，排在 M4。',
    fallback: { label: '去发起评测（第 3 步配置算子）', href: '/runs/new' },
  },
  pg09: {
    pageId: 'PG-09',
    title: '管理配置',
    milestone: 'M2 / M4',
    message: '管理配置页将在 M2 / M4 分阶段上线。',
    reason:
      '模型网关配置 Tab 属 M2（M1 只用本地 fixture 网关，配置界面此刻是假功能）；门禁规则、基线确认、推送渠道三个 Tab 属 M4。',
    fallback: { label: '回到评测运行台', href: '/runs' },
  },
};

export function placeholderNotice(key: PlaceholderKey): PlaceholderNotice {
  return PLACEHOLDER_NOTICES[key];
}
