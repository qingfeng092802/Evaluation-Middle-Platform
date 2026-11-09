/**
 * `PG-05` 评测集页面的展示口径单测。
 *
 * 这里锁的是三类「写错了也照常渲染」的东西：
 *  1. 空值必须显示 `—`，不能显示 `0` / `null`（版本号、条目数都是 `NULL` 合法的）；
 *  2. 不可变提示的**逐字原文**（`pages-and-flows.md` `PG-05`），且版本号必须跟着实际版本走；
 *  3. 「生成新版本」的可用性只能由 `canCommit` 决定 —— 零通过时还能点，
 *     就会用一个注定 409 的请求把用户绕进死胡同。
 */
import { describe, expect, it } from 'vitest';
import type { ImportValidationReport } from '@eval-platform/contracts';
import {
  caseCountCell,
  datasetSourceLabel,
  inferFormat,
  importBlockedReason,
  importCanCommit,
  versionCell,
  versionFrozenNotice,
} from '../lib/ui/datasets.js';

const report = (okCount: number, failedCount: number, canCommit: boolean): ImportValidationReport => ({
  okCount,
  failedCount,
  issues:
    failedCount === 0
      ? []
      : Array.from({ length: failedCount }, (_, i) => ({ line: i + 1, message: '坏行' })),
  canCommit,
});

describe('评测集列表单元格', () => {
  it('尚无版本时显示 — 而不是 0', () => {
    expect(versionCell(null)).toBe('—');
    expect(caseCountCell(null)).toBe('—');
  });

  it('有版本时显示 vN 与条目数', () => {
    expect(versionCell(3)).toBe('v3');
    expect(caseCountCell(50)).toBe('50');
    expect(caseCountCell(0)).toBe('0');
  });

  it('来源三档文案与契约枚举一一对应', () => {
    expect(datasetSourceLabel('import')).toBe('导入');
    expect(datasetSourceLabel('mine')).toBe('挖掘');
    expect(datasetSourceLabel('backflow')).toBe('回流');
  });

  it('无版本时来源为 — （不猜一个默认的「导入」）', () => {
    expect(datasetSourceLabel(null)).toBe('—');
  });
});

describe('不可变提示（PG-05 原文，版本号按实际版本填充）', () => {
  it('v3 时与 pages-and-flows.md 原文逐字相同', () => {
    expect(versionFrozenNotice(3)).toBe(
      '版本 v3 已发布，不可修改。如需调整数据，请导入并生成新版本。',
    );
  });

  it('版本号跟着实际版本走（不能写死 v3）', () => {
    expect(versionFrozenNotice(1)).toContain('版本 v1 已发布');
    expect(versionFrozenNotice(12)).toContain('版本 v12 已发布');
  });
});

describe('校验结果 → 能否生成新版本', () => {
  it('还没校验过 ⇒ 不可点', () => {
    expect(importCanCommit(null)).toBe(false);
  });

  it('零通过 ⇒ 不可点，并给出「没有可导入的有效记录」原文', () => {
    const zero = report(0, 3, false);
    expect(importCanCommit(zero)).toBe(false);
    expect(importBlockedReason(zero)).toBe('没有可导入的有效记录，请检查文件格式。');
  });

  it('部分失败 ⇒ 不可点，且不冒充「零通过」的文案', () => {
    const partial = report(298, 2, false);
    expect(importCanCommit(partial)).toBe(false);
    expect(importBlockedReason(partial)).toBeNull();
  });

  it('全通过 ⇒ 可点，无阻断原因', () => {
    const allOk = report(50, 0, true);
    expect(importCanCommit(allOk)).toBe(true);
    expect(importBlockedReason(allOk)).toBeNull();
  });
});

describe('格式推断（上传面板不信任扩展名）', () => {
  it('按扩展名判断', () => {
    expect(inferFormat('cases.jsonl', '')).toBe('jsonl');
    expect(inferFormat('cases.csv', '')).toBe('csv');
  });

  it('扩展名不可靠时看内容首字符', () => {
    expect(inferFormat('upload.txt', '{"input":{"query":"q"}}')).toBe('jsonl');
    expect(inferFormat('upload.txt', 'case_key,query\nk1,q')).toBe('csv');
  });
});
