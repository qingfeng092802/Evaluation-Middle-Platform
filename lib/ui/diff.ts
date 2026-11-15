/**
 * 行级 Diff 纯函数（PG-04 双栏抽屉的数据面）。
 *
 * 算法：LCS 行级对齐。输入按 `\n` 切分（尾部换行规范化，不产生幽灵空行）；
 * 输出三种行：`same`（两侧一致）/ `del`（基线有、当前无）/ `add`（当前有、基线无）。
 * 回溯时连续的 del 段先于连续的 add 段输出——modified 行呈现为相邻的 − 行与 + 行，
 * 与 `DESIGN.md` §4.3 的 −/+ 前缀约定一致。
 *
 * 复杂度 O(n×m)：PG-04 的输入是单条 Case 的输出文本（fixture 与真实 run 均为
 * KB 量级），LCS 足够；无外部依赖（不为一个纯函数拉 diff 库）。
 */
export type DiffRowType = 'same' | 'del' | 'add';

export interface DiffRow {
  readonly type: DiffRowType;
  readonly text: string;
}

function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return normalized === '' ? [] : normalized.split('\n');
}

/** LCS 长度表（(a.length+1) × (b.length+1)）。 */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }
  return table;
}

/** 统一视图：LCS 回溯产出 same/del/add 序列。 */
export function unifiedDiffLines(baselineText: string, currentText: string): DiffRow[] {
  const a = toLines(baselineText);
  const b = toLines(currentText);
  const table = lcsTable(a, b);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      rows.push({ type: 'del', text: a[i] ?? '' });
      i += 1;
    } else {
      rows.push({ type: 'add', text: b[j] ?? '' });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({ type: 'del', text: a[i] ?? '' });
    i += 1;
  }
  while (j < b.length) {
    rows.push({ type: 'add', text: b[j] ?? '' });
    j += 1;
  }
  return rows;
}

export interface SplitDiff {
  /** 基线侧：same + del（按 unified 序）。 */
  left: DiffRow[];
  /** 当前侧：same + add（按 unified 序）。 */
  right: DiffRow[];
}

/**
 * 并排视图：从同一份 unified 序列派生出两侧行——
 * 左栏只保留 same/del，右栏只保留 same/add。与 unified 共享同一 LCS 结果，
 * 两种视图不会互相矛盾（`DESIGN.md` §4.3 的 Tabs 双视图）。
 */
export function splitDiffLines(baselineText: string, currentText: string): SplitDiff {
  const unified = unifiedDiffLines(baselineText, currentText);
  return {
    left: unified.filter((r) => r.type === 'same' || r.type === 'del'),
    right: unified.filter((r) => r.type === 'same' || r.type === 'add'),
  };
}
