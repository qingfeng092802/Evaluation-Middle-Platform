/**
 * `B-02` 回归门禁：**接口返回 N 条 ⇒ 表格必须渲染 N 行**。
 *
 * ## 为什么这条断言要单独存在
 *
 * 独立验收看到的现象是「`/api/datasets` 返回 3 条，页面却显示『还没有评测集』」。
 * 单看任何一层都是绿的：
 *
 *  - 接口层：200，`items.length === 3`；
 *  - 组件层：`DataTable` 拿到 3 条就能渲染 3 行（本文件下半部分锁死）；
 *  - 浏览器层：HTML 里也确实有表格。
 *
 * 断掉的是**它们之间**：`.next` 里生产与 dev 两套产物混用，客户端 chunk 全部
 * 404，页面没有水合，`useApi` 的数据永远进不了表格（根因与门禁见
 * `tests/next-artifacts.spec.ts` / `scripts/check-next-artifacts.ts`）。
 *
 * 所以这条断言的价值就在于**跨层对账**：拿接口条数去比实际渲染行数。
 * 它可以是纯函数（`judgeRenderParity`），真实浏览器那一层由
 * `scripts/check-datasets-render.ts` 承担 —— 两者共用同一个判定，避免
 * 「脚本里判一套、测试里判另一套」。
 *
 * 上半部分：判定函数（喂数字，断言判定正确）。
 * 下半部分：`DataTable` 的真实静态标记（喂 N 条，数 `<tr>`）。
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { judgeRenderParity } from '../scripts/check-datasets-render.js';
import { DataTable, type DataTableColumn } from '../components/ui/data-table';

// ---------------------------------------------------------------------------
// 上半部分：跨层判定
// ---------------------------------------------------------------------------

describe('judgeRenderParity · 条数对不上必须判失败', () => {
  it('接口 3 条、渲染 3 行 ⇒ 通过', () => {
    expect(judgeRenderParity({ apiItems: 3, renderedRows: 3, statusCount: 3 })).toEqual([]);
  });

  it('接口 3 条、渲染 0 行 ⇒ 失败，且指出「有数据却空表」', () => {
    const issues = judgeRenderParity({ apiItems: 3, renderedRows: 0, statusCount: 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('ROWS_MISMATCH');
    expect(issues[0]?.message).toContain('3');
  });

  it('接口 0 条、渲染 0 行 ⇒ 通过（空状态是合法终态）', () => {
    expect(judgeRenderParity({ apiItems: 0, renderedRows: 0, statusCount: 0 })).toEqual([]);
  });

  it('渲染行数与屏幕阅读器计数不一致 ⇒ 失败（两者不可能同时正确）', () => {
    const issues = judgeRenderParity({ apiItems: 3, renderedRows: 3, statusCount: 2 });
    expect(issues.map((i) => i.code)).toContain('STATUS_MISMATCH');
  });

  it('接口条数少于渲染行数（重复行 / 旧帧残留）⇒ 也判失败，不能只在「少了」时报警', () => {
    const issues = judgeRenderParity({ apiItems: 2, renderedRows: 5, statusCount: 5 });
    expect(issues.map((i) => i.code)).toContain('ROWS_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// 下半部分：DataTable 的真实静态标记
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  readonly name: string;
}

const columns: readonly DataTableColumn<Row>[] = [
  { id: 'name', header: '名称', cell: (r) => r.name },
];

function renderTable(rows: readonly Row[], loading = false): string {
  return renderToStaticMarkup(
    React.createElement(DataTable<Row>, {
      columns,
      rows,
      getRowId: (r: Row) => r.id,
      loading,
      emptyKey: 'datasets',
    }),
  );
}

/** 只数 `<tbody>` 里的行：表头也是 `<tr>`，混进来会恒多 1 行。 */
function bodyRowCount(html: string): number {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
  return (body.match(/<tr/g) ?? []).length;
}

describe('DataTable · 行数严格跟随入参', () => {
  it('3 条 ⇒ tbody 里恰好 3 个 <tr>，并渲染「共 3 条记录」', () => {
    const html = renderTable([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]);
    expect(bodyRowCount(html)).toBe(3);
    expect(html).toMatch(/role="status"[^>]*>共\s*3\s*条记录/);
  });

  it('1 条 ⇒ 1 行（不是「有数据就渲染固定行数」）', () => {
    expect(bodyRowCount(renderTable([{ id: 'a', name: 'A' }]))).toBe(1);
  });

  it('0 条 + 给了 emptyKey ⇒ 渲染空状态、不渲染表格', () => {
    const html = renderTable([]);
    expect(html).not.toContain('<table');
    expect(html).toContain('还没有评测集');
  });

  it('loading 优先于空状态：不给空表也不给空状态，给骨架', () => {
    const html = renderTable([], true);
    expect(html).not.toContain('<table');
    expect(html).not.toContain('还没有评测集');
  });
});
