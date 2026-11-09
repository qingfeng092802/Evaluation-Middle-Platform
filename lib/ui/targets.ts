/**
 * `PG-06` 待测目标页面的展示口径（纯函数）。
 *
 * 这里挡的是三类「不报错但会骗人」的渲染：
 *  1. **T2 可用性**：`TARGET_T2_ENABLED=false` 时 UI 必须置灰并标注「P1 支持」。
 *     把这句话写成常量并单测，避免哪天顺手改成「开发中」——事实文档的原文是「P1 支持」。
 *  2. **无当前版本**：`currentVersion === null` 是合法状态（理论上不该出现，
 *     因为 `TargetCreate` 同时建 v1），但真出现时显示 `—`，绝不渲染一份空配置冒充可用。
 *  3. **版本语义文案**：`保存后将生成 v2，历史运行仍引用 v1` 是 `PG-06` 的原文，
 *     版本号必须跟着实际版本走。
 */
import type { Target, TargetVersion } from '@eval-platform/contracts';
import { EMPTY } from '../format/index.js';

/** T2 置灰时挂在选项后面的标注（`pages-and-flows.md` `PG-06` 区域 3 原文）。 */
export const T2_DISABLED_LABEL = 'P1 支持';

/**
 * T2 是否可选。
 *
 * 入参显式传入而不是在这里 import `TARGET_T2_ENABLED`：
 * 让本函数保持纯函数、可被两种开关状态各测一次。
 * 调用方传的正是契约里的那个单点开关。
 */
export function isT2Selectable(t2Enabled: boolean): boolean {
  return t2Enabled;
}

const KIND_LABEL: Readonly<Record<Target['kind'], string>> = {
  t1_prompt: 'T1 Prompt',
  t2_http: 'T2 HTTP',
};

export function targetKindLabel(kind: Target['kind']): string {
  return KIND_LABEL[kind];
}

/** 从 URL 里取主机名；解析失败时原样返回（不吞掉用户填错的结果）。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 单个版本的「模型」摘要。
 *
 * T1 显示 `modelId`（人认得的模型名），**不显示** `modelProviderId` 那个 UUID ——
 * UUID 在表格里既占宽又看不懂。
 * T2 没有模型概念，显示 endpoint 主机名，让「这是打到哪个域」一眼可见。
 *
 * 单独导出而不并进 `modelCell`：版本历史里本人拿到的就是 `TargetVersion`，
 * 若为了复用而临时拼一个假 `Target` 对象，那个假 `name` / `updatedAt` 迟早
 * 会被某处误读成真值。
 */
export function modelCellOf(version: TargetVersion | null): string {
  if (version === null) return EMPTY;
  return version.config.kind === 't1_prompt'
    ? version.config.modelId
    : hostOf(version.config.endpointUrl);
}

/** 列表「模型」列 = 当前版本的模型摘要；无当前版本时 `—`。 */
export function modelCell(target: Target): string {
  return modelCellOf(target.currentVersion);
}

/**
 * 「当前版本」列：`v1` / `v2`…；`0` 表示还没有版本（理论上不该出现）。
 *
 * `0` 不渲染成 `v0` —— 版本号从 1 开始，`v0` 会让人以为存在一个空版本。
 */
export function currentVersionCell(currentVersionNo: number): string {
  return currentVersionNo === 0 ? EMPTY : `v${String(currentVersionNo)}`;
}

const PROMPT_MAX = 40;

/**
 * Prompt 模板摘要。
 *
 * 去换行是必须的：表格行高固定 36px，一个多行模板会把整行撑高，
 * 后面的列全部错位。截断保留 `{{…}}` 变量的可见性，因为那正是用户要核对的东西。
 */
export function promptSummary(version: TargetVersion | null): string {
  if (version === null) return EMPTY;
  if (version.config.kind !== 't1_prompt') return EMPTY;
  const oneLine = version.config.promptTemplate.replace(/\s+/g, ' ').trim();
  return oneLine.length <= PROMPT_MAX ? oneLine : `${oneLine.slice(0, PROMPT_MAX)}…`;
}

/**
 * 版本语义提示（`PG-06` 原文）。
 *
 * 「历史运行仍引用 vN」不是安抚话术：它对应 `PT-1` 的配置快照——
 * 改 Target 只产生新版本，已完成的 EvalRun 仍读它建 run 时那份快照。
 */
export function nextVersionHint(currentVersionNo: number): string {
  return `保存后将生成 v${String(currentVersionNo + 1)}，历史运行仍引用 v${String(currentVersionNo)}`;
}
