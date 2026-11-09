/**
 * `PG-05` 评测集页面的展示口径（纯函数）。
 *
 * 与 `runs.ts` 同一套思路：凡是「写错了也照常渲染」的判断都搬到这里，
 * 好让 `pages-and-flows.md` 的原文能被单测逐字锁死，而不是靠人眼看一遍。
 */
import type { DatasetSource, ImportValidationReport } from '@eval-platform/contracts';
import { EMPTY } from '../format/index.js';

// ---------------------------------------------------------------------------
// 列表单元格（`PG-05` 区域 2）
// ---------------------------------------------------------------------------

/**
 * 「最新版本」列。
 *
 * `null` ⇒ `—` 而不是 `v0`：没有版本的评测集是**合法状态**（刚建容器还没导入），
 * 显示 `v0` 会让人以为存在一个空版本——而空版本在本系统里被契约禁止（`min(1)`）。
 */
export function versionCell(latestVersionNo: number | null): string {
  return latestVersionNo === null ? EMPTY : `v${String(latestVersionNo)}`;
}

/** 「条目数」列。`null` ⇒ `—`（尚无版本），`0` 是真实的零条，必须显示 `0`。 */
export function caseCountCell(caseCount: number | null): string {
  return caseCount === null ? EMPTY : String(caseCount);
}

const SOURCE_LABEL: Readonly<Record<DatasetSource, string>> = {
  import: '导入',
  mine: '挖掘',
  backflow: '回流',
};

/** 「来源」列。枚举 → 中文，映射只此一处（避免三个页面各写一个 `switch`）。 */
export function datasetSourceLabel(source: DatasetSource | null): string {
  return source === null ? EMPTY : SOURCE_LABEL[source];
}

/**
 * 版本详情顶部固定文案（`pages-and-flows.md` `PG-05` 原文）。
 *
 * 版本号按实际版本填充：事实文档里写的是 `v3` 是因为当时举的是 v3 的例子，
 * 写死 `v3` 会让「v1 的页面说自己是 v3」——那比不显示更糟。
 */
export function versionFrozenNotice(versionNo: number): string {
  return `版本 v${String(versionNo)} 已发布，不可修改。如需调整数据，请导入并生成新版本。`;
}

// ---------------------------------------------------------------------------
// 上传面板（`PG-05` 区域 3）
// ---------------------------------------------------------------------------

/**
 * 「生成新版本」是否可点。
 *
 * 只认服务端的 `canCommit`，前端不自己算「okCount > 0」：
 * 允不允许提交是业务口径，前端再推一遍就多了一处会漂移的判据。
 * 未校验（`null`）一律不可点。
 */
export function importCanCommit(report: ImportValidationReport | null): boolean {
  return report !== null && report.canCommit;
}

/**
 * 校验被阻断时的说明文案。
 *
 * 只在一**条都没通过**时给「没有可导入的有效记录」：
 * 那正是 `pages-and-flows.md` §5 的原文场景。部分失败有通过行时不给这句话——
 * 用户看到「通过 298 / 失败 2」还被告知「没有有效记录」，只会怀疑页面坏了。
 */
export function importBlockedReason(report: ImportValidationReport | null): string | null {
  if (report === null) return null;
  if (report.okCount > 0) return null;
  return '没有可导入的有效记录，请检查文件格式。';
}

/**
 * 从文件名 / 内容推断格式。
 *
 * **不只看扩展名**：用户把 JSONL 存成 `.txt` 是常事，而解析器分不清格式的后果
 * 是整份文件「第 1 行就不是合法 JSON」，看起来像用户的数据全坏了。
 * 扩展名无法判定时看首个非空白字符：`{` 开头按 JSONL，否则按 CSV。
 */
export function inferFormat(filename: string, content: string): 'jsonl' | 'csv' {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.json')) return 'jsonl';
  if (lower.endsWith('.csv')) return 'csv';
  return content.trimStart().startsWith('{') ? 'jsonl' : 'csv';
}
