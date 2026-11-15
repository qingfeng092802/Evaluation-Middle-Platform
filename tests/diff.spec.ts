/**
 * 行级 Diff 纯函数单测（PG-04 双栏抽屉的数据面）。
 *
 * 「写错了也照常渲染」的典型：把「没配算子」补成 0、把 modified 画成同一行、
 * 丢掉尾部换行后的空行——只有逐条断言拦得住。
 * 算法：LCS 行级对齐；连续的 del 段先于连续的 add 段输出（modified 呈现为
 * 相邻的 − 行与 + 行，与 DESIGN §4.3 的 −/+ 前缀约定一致）。
 */
import { describe, expect, it } from 'vitest';
import { splitDiffLines, unifiedDiffLines } from '../lib/ui/diff.js';

describe('unifiedDiffLines · 行级 LCS', () => {
  it('完全一致 → 全部 same，无前缀行', () => {
    expect(unifiedDiffLines('a\nb\nc', 'a\nb\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('当前新增一行 → 一条 add（+）', () => {
    expect(unifiedDiffLines('a\nc', 'a\nb\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('当前删除一行 → 一条 del（−）', () => {
    expect(unifiedDiffLines('a\nb\nc', 'a\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('修改一行 → 相邻的 del + add（不冒充 same）', () => {
    expect(unifiedDiffLines('answer v1', 'answer v2')).toEqual([
      { type: 'del', text: 'answer v1' },
      { type: 'add', text: 'answer v2' },
    ]);
  });

  it('空 ↔ 有内容：del/add 各司其职，不产生幽灵行', () => {
    expect(unifiedDiffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
    expect(unifiedDiffLines('x\ny', '')).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ]);
  });

  it('尾部换行规范化：不产生幽灵空行', () => {
    expect(unifiedDiffLines('a\n', 'a')).toEqual([{ type: 'same', text: 'a' }]);
  });

  it('多行重排：same 行是公共子序列（LCS=3），错位行各一条 del/add', () => {
    const rows = unifiedDiffLines('1\n2\n3\n4', '1\n3\n2\n4');
    const same = rows.filter((r) => r.type === 'same').map((r) => r.text);
    const del = rows.filter((r) => r.type === 'del').map((r) => r.text);
    const add = rows.filter((r) => r.type === 'add').map((r) => r.text);
    expect(same).toEqual(['1', '3', '4']);
    expect(del).toEqual(['2']);
    expect(add).toEqual(['2']);
  });
});

describe('splitDiffLines · 双栏两侧', () => {
  it('左栏=基线视角（same+del），右栏=当前视角（same+add）', () => {
    const { left, right } = splitDiffLines('a\nb\nc', 'a\nx\nc');
    expect(left).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
    expect(right).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('完全一致 → 两栏 same 行数一致', () => {
    const { left, right } = splitDiffLines('r\ns', 'r\ns');
    expect(left).toEqual(right);
    expect(left).toHaveLength(2);
  });

  it('与 unified 共享同一 LCS 结果（两种视图不矛盾）', () => {
    const a = 'q\nw\ne';
    const b = 'q\ne\nr';
    const unified = unifiedDiffLines(a, b);
    const { left, right } = splitDiffLines(a, b);
    expect(left.filter((r) => r.type === 'del')).toEqual(unified.filter((r) => r.type === 'del'));
    expect(right.filter((r) => r.type === 'add')).toEqual(unified.filter((r) => r.type === 'add'));
  });
});
