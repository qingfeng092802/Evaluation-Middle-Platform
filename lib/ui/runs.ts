/**
 * 运行页面的展示口径（`PG-01` / `PG-03`）。
 *
 * 与 `derive.ts` 的分工：那里是「状态 → 语义」，这里是「运行数据 → 一段用户读得懂的文字」。
 * 全部纯函数，不碰 DOM、不发请求 —— 因为它们决定文案与轮询行为，
 * 而那两件事恰恰是「写错了也不报错」的典型。
 */
import type {
  CaseResultStatus,
  EvalRun,
  ImportIssue,
  Reproducibility,
  RunPreflight,
} from '@eval-platform/contracts';
import { isTerminalRunStatus } from '@eval-platform/contracts';
import { EMPTY, formatCost, formatLatency, formatRate, formatScore, formatTokens, truncateHash } from '../format/index.js';
import { primaryMetricOf, type StatusTone } from './derive.js';

// ---------------------------------------------------------------------------
// 轮询（`[FE-03]` 交付物 5）
// ---------------------------------------------------------------------------

/** 2s 轮询间隔（M1 用轮询代替 SSE，`milestones.md` 已拍板）。 */
export const POLL_INTERVAL_MS = 2000;

/**
 * 是否该继续轮询。
 *
 * 停的三个条件缺一不可，漏一个都会变成「页面开着就一直每 2 秒打一次接口」：
 *  1. 进入终态 —— 终态之后数据不会再变；
 *  2. 页面不可见 —— 用户在别的标签页时没必要请求；
 *  3. 已卸载 —— 由调用方的 cleanup 处理，所以这里返回 `false` 也算安全的兜底。
 *
 * 返回 `boolean` 而不是「下一个延迟秒数」：轮询节奏是常量，不该被业务逻辑改来改去。
 */
export function shouldPoll(status: EvalRun['status'], hidden: boolean, mounted: boolean): boolean {
  if (!mounted) return false;
  if (isTerminalRunStatus(status)) return false;
  if (hidden) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 进度（`PG-03` 区域 3）
// ---------------------------------------------------------------------------

/**
 * 进度文案：`已完成 128 / 300，失败 2`。
 *
 * `PENDING` 单独处理为「等待调度」：此时 `total` 已定但 `completed` 必为 0，
 * 渲染成 `已完成 0 / 300` 会让人以为已经开跑却卡住了。
 */
export function progressLabel(run: {
  status: EvalRun['status'];
  totalCases: number;
  succeededCases: number;
  failedCases: number;
}): string {
  if (run.status === 'PENDING') return '等待调度';
  const done = run.succeededCases + run.failedCases;
  return run.failedCases > 0
    ? `已完成 ${String(done)} / ${String(run.totalCases)}，失败 ${String(run.failedCases)}`
    : `已完成 ${String(done)} / ${String(run.totalCases)}`;
}

/** 进度条百分比（0–100）。`total === 0` 时返回 0，不返回 NaN。 */
export function progressPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  const pct = (completed / total) * 100;
  return Math.max(0, Math.min(100, pct));
}

// ---------------------------------------------------------------------------
// 列表单元格（`PG-01` 区域 3）
// ---------------------------------------------------------------------------

/**
 * `PG-01` 列表的「耗时」「Token 成本」两列的展示值。
 *
 * 耗时取 `finishedAt - startedAt`，但**只在两个时间都有值时才计算**：
 * `RUNNING` 的 `finishedAt` 是 null，用 `now` 补会得到一个每次刷新都在变的数字，
 * 那不是「耗时」，是「已经跑了多久」，两者在列表里混着显示会误导。
 */
export function runDurationLabel(run: {
  startedAt: string | null;
  finishedAt: string | null;
}): string {
  if (run.startedAt === null || run.finishedAt === null) return '—';
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 列表里的成本列（汇总口径，2 位小数）。 */
export function runCostLabel(run: EvalRun): string {
  return formatCost(run.metrics.costTotal, 'total');
}

/**
 * 列表里的综合得分列。
 *
 * `FAILED` 的 `scoreOverall` 恒为 NULL，`formatScore(null)` 已经是 `—`；
 * 这里再做一次显式判断的意义在于：**将来如果有人给 `FAILED` 补上分数**，
 * 页面也仍然显示 `—`，不会突然冒出一个「失败但得分 0.83」的自相矛盾。
 */
export function runScoreLabel(run: EvalRun): string {
  if (run.status === 'FAILED') return '—';
  return formatScore(run.metrics.scoreOverall);
}

// ---------------------------------------------------------------------------
// 前置依赖横幅（`PG-01` 区域 2 / `US-015`）
// ---------------------------------------------------------------------------

/**
 * 是否显示「尚未配置模型网关凭证」横幅。
 *
 * 只依据 `hasProviderCredentials`，不看 `canStart`：`canStart` 还包含「有没有算子」
 * 这类**本次配置**的问题，用它驱动横幅会让用户看到一句与真实原因不符的提示。
 */
export function showProviderBanner(preflight: RunPreflight | null): boolean {
  return preflight !== null && !preflight.hasProviderCredentials;
}

// ---------------------------------------------------------------------------
// 导入校验结果（`PG-05` 区域 3）
// ---------------------------------------------------------------------------

/**
 * 单条失败行文案：`第 47 行：缺少 case_key 且 input 为空`。
 *
 * 行号是**物理行号**（`D-11`：CSV 表头计入），服务端已算好，这里只负责拼字。
 * 不在前端 +1 —— 行号口径只能有一处。
 */
export function importIssueLine(issue: ImportIssue): string {
  const field = issue.field === undefined ? '' : `[${issue.field}] `;
  return `第 ${String(issue.line)} 行：${field}${issue.message}`;
}

/** 校验结果标题：`通过 298 条 / 失败 2 条`。 */
export function importSummary(okCount: number, failedCount: number): string {
  return `通过 ${String(okCount)} 条 / 失败 ${String(failedCount)} 条`;
}

// ---------------------------------------------------------------------------
// 详情页元数据栏（`PG-03` 区域 1）
// ---------------------------------------------------------------------------

/** 明细表里的算子分数摘要：`recall_at_k 0.8000 · regex 1.0000`。 */
export function operatorScoresSummary(
  scores: readonly { readonly key: string; readonly score: number }[] | null,
): string {
  if (scores === null || scores.length === 0) return '—';
  return scores.map((s) => `${s.key} ${formatScore(s.score)}`).join(' · ');
}

/** 明细表 `Case Key` 列：前 8 位 + 省略号，完整值放 `title`。 */
export function caseKeyLabel(caseKey: string): string {
  return truncateHash(caseKey);
}

// ---------------------------------------------------------------------------
// 详情页指标卡（`PG-03` 区域 2）
// ---------------------------------------------------------------------------

/** 指标卡的键。顺序即渲染顺序，第一张是主位。 */
export type MetricCardKey =
  | 'scoreOverall'
  | 'passRate'
  | 'coverage'
  | 'latencyP50'
  | 'latencyP95'
  | 'tokens'
  | 'costTarget'
  | 'costJudge';

export interface MetricCard {
  readonly key: MetricCardKey;
  readonly label: string;
  readonly value: string;
  /** 主位：字号更大、置顶（`DESIGN.md` §4.3 指标卡层级）。 */
  readonly primary: boolean;
  /** 数字列一律 `.num`，由组件施加；这里声明是为了让单元测试能核对「哪张卡是数字」。 */
  readonly numeric: true;
}

/**
 * 汇总指标卡（`PG-03` 区域 2）。
 *
 * 三条口径在这里一次性钉死：
 *  1. 主位由 `primaryMetricOf()` 决定 —— `FAILED` 时换成 `coverage`。
 *     它不是「多显示一张卡」，而是**第一张卡换人**：`FAILED` 的 `score_overall` 恒为
 *     `NULL`，继续让它在主位，用户第一眼看到的是「—」。
 *  2. 成本**分列**「待测成本」/「裁判成本」，不出现相加后的数（`OPEN-3`）。
 *     数据库有 `cost_total` 这个 STORED 列，但那是汇总口径，不是这里要展示的明细。
 *  3. `null` 一律 `—`。`FAILED` 的分数、无阈值的通过率都是 `NULL`。
 */
export function metricCardsOf(run: {
  status: EvalRun['status'];
  metrics: EvalRun['metrics'];
}): readonly MetricCard[] {
  const primaryKey: MetricCardKey = primaryMetricOf(run.status);
  const m = run.metrics;

  const cards: readonly Omit<MetricCard, 'primary' | 'numeric'>[] = [
    { key: 'scoreOverall', label: '综合得分', value: formatScore(m.scoreOverall) },
    { key: 'passRate', label: '通过率', value: formatRate(m.passRate) },
    { key: 'coverage', label: '覆盖率', value: formatRate(m.coverage) },
    { key: 'latencyP50', label: '耗时 P50', value: formatLatency(m.latencyP50Ms) },
    { key: 'latencyP95', label: '耗时 P95', value: formatLatency(m.latencyP95Ms) },
    {
      key: 'tokens',
      label: 'Token 总量',
      value: formatTokens(m.tokensInTotal + m.tokensOutTotal),
    },
    { key: 'costTarget', label: '待测成本', value: formatCost(m.costTarget, 'total') },
    { key: 'costJudge', label: '裁判成本', value: formatCost(m.costJudge, 'total') },
  ];

  // 主位换人时把它挪到第一位，而不是只标个 `primary: true`：
  // 卡片顺序决定了渲染顺序，主位排在第六张就等于没做主位。
  const ordered = [
    ...cards.filter((c) => c.key === primaryKey),
    ...cards.filter((c) => c.key !== primaryKey),
  ];

  return ordered.map((c) => ({ ...c, primary: c.key === primaryKey, numeric: true }));
}

// ---------------------------------------------------------------------------
// 可复现性展开（`PG-03` 元数据栏 · `OPEN-4`）
// ---------------------------------------------------------------------------

export interface ReproRow {
  readonly label: string;
  readonly value: string;
  /** hash / 版本串这类标识符用等宽字体。 */
  readonly mono: boolean;
}

function numOrEmpty(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY : String(value);
}

/**
 * 「EvalRun 可解释，不可复现。」点击展开后的字段表。
 *
 * 字段名与顺序逐字取自 `pages-and-flows.md` `PG-03`，用 snake_case（那是
 * `reproducibility` 在学生心里的原始列名）。**`cache_policy` 恒为 `none`**：
 * 它是契约里的 `z.literal('none')`，这里不做 `??` 兜底——兜底会把一个本该
 * 编译不过的情形变成静默的假数据。
 */
export function reproducibilityRows(repro: Reproducibility): readonly ReproRow[] {
  return [
    { label: 'temperature', value: numOrEmpty(repro.temperature), mono: true },
    { label: 'top_p', value: numOrEmpty(repro.topP), mono: true },
    { label: 'max_tokens', value: numOrEmpty(repro.maxTokens), mono: true },
    { label: 'seed', value: numOrEmpty(repro.seed), mono: true },
    { label: 'runner_version', value: repro.runnerVersion, mono: true },
    { label: 'model_version_string', value: repro.modelVersionString ?? EMPTY, mono: true },
    { label: 'prompt_template_hash', value: truncateHash(repro.promptTemplateHash), mono: true },
    { label: 'cache_policy', value: repro.cachePolicy, mono: true },
  ];
}

// ---------------------------------------------------------------------------
// 明细表「状态」列（`PG-03` 区域 5）
// ---------------------------------------------------------------------------

const CASE_STATUS_TEXT: Readonly<Record<CaseResultStatus, string>> = {
  OK: '通过',
  FAILED: '失败',
  TIMEOUT: '超时',
  PARSE_ERROR: '解析失败',
  QUOTA_EXCEEDED: '额度耗尽',
  SKIPPED: '跳过',
};

export function caseStatusLabel(status: CaseResultStatus): string {
  return CASE_STATUS_TEXT[status];
}

/**
 * 结果状态 → 语义档。
 *
 * 只有三档而不是六档，是因为**非 `OK` 一律 `score = NULL`**（`ck_eval_case_results_ok_score`）：
 * 「超时」与「解析失败」对读者是同一件事——这条没算出分。把六种状态染成六种颜色，
 * 会让人以为「解析失败比超时轻」。
 */
export function caseStatusTone(status: CaseResultStatus): StatusTone {
  if (status === 'OK') return 'pass';
  if (status === 'SKIPPED') return 'muted';
  return 'fail';
}
