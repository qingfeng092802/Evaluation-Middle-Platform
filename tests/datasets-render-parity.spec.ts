/**
 * `PG-05` 列表口径（`SPEC-M1` `[FE-02]` 交付物 1）+ 浏览器级几何断言。
 *
 * 这里锁死四类「写错了也照常渲染」的事：
 *
 *  1. **列集合恰好 6 列**：`[FE-02]` 交付物 1 与 `pages-and-flows.md` `PG-05` 区域 2
 *     逐字相同 —— `名称 ｜ 最新版本 ｜ 条目数 ｜ 来源 ｜ 最近更新 ｜ 操作`。
 *     少一列、多一列、换个表头，页面照样能跑，只有对着渲染结果断言才拦得住。
 *     特别地：**原型是卡片网格**，本项目要的是 6 列表格；若有人“顺手”按原型改成
 *     卡片，或加上原型里的额外交互（删除/导出），这里会红。
 *
 *  2. **数字列三列**（最新版本 / 条目数 / 最近更新）必须 `num` + `text-right`：
 *     `tabular-nums` 是列对齐的前提（`DESIGN.md` §3.2 / §3.3）。
 *
 *  3. **空值显示 `—` 而不是 `0`**：无版本的评测集是合法状态（刚建容器还没导入），
 *     渲染 `0` 会被读成“有 0 条”。
 *
 *  4. **行操作只有「查看版本」**：`pages-and-flows.md` 明确不做「删除版本」（违反
 *     `PT-2`）与「导出 JSONL」（无故事支撑）。多一颗按钮就是越界。
 *
 * 浏览器层（几何）复用 `/runs` 已验证过的同一套读法：逐格文本行数 + 容器 scrollWidth。
 * 条件不满足时**跳过并显式打印原因**（跳过 ≠ 通过）。
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Dataset } from '@eval-platform/contracts';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DataTable } from '../components/ui/data-table';
import { datasetsTableColumns } from '../components/datasets/datasets-table-columns';
import { EDGE_PATH, tryLocalChromium } from '../scripts/pw-local.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env['PG_BASE'] ?? 'http://127.0.0.1:3000';

/** 一条「字段都填满」的评测集：有版本、有条目数、有来源。 */
function fullDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    name: '客服QA评测集',
    description: '线上客服问答回归用',
    latestVersionNo: 3,
    caseCount: 50,
    latestSource: 'import',
    createdAt: '2026-11-01T02:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

function renderDatasetsTable(rows: readonly Dataset[]): string {
  return renderToStaticMarkup(
    React.createElement(DataTable<Dataset>, {
      columns: datasetsTableColumns(),
      rows,
      getRowId: (d: Dataset) => d.id,
    }),
  );
}

/** 取表头文字（按列序）。剥掉排序提示与 `srOnlyHeader` 的补充说明。 */
function headerCells(html: string): string[] {
  const thead = /<thead[\s\S]*?<\/thead>/.exec(html)?.[0] ?? '';
  return [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    (m[1] ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/，点击切换排序/g, '')
      .replace(/（[^）]*）$/g, '')
      .trim(),
  );
}

/** 取 tbody 里每一行的单元格文字。 */
function bodyRows(html: string): string[][] {
  const tbody = /<tbody[\s\S]*?<\/tbody>/.exec(html)?.[0] ?? '';
  return [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((td) =>
      (td[1] ?? '').replace(/<[^>]+>/g, '').trim(),
    ),
  );
}

// ---------------------------------------------------------------------------
// 1. 列集合
// ---------------------------------------------------------------------------

describe('/datasets 列集合 · 逐字对齐 SPEC-M1 [FE-02] 交付物 1', () => {
  it('表头 = 原文 6 列，顺序一致（不多不少）', () => {
    expect(headerCells(renderDatasetsTable([fullDataset()]))).toEqual([
      '名称',
      '最新版本',
      '条目数',
      '来源',
      '最近更新',
      '操作',
    ]);
  });

  it('不得出现原型卡片网格才有的字段（如「Case 数」自造列 / 删除 / 导出）', () => {
    const headers = headerCells(renderDatasetsTable([fullDataset()]));
    for (const forbidden of ['Case 数', '案例数', '删除', '导出']) {
      expect(headers, `表头不得含「${forbidden}」`).not.toContain(forbidden);
    }
  });

  it('数字列三列右对齐且带 .num（tabular-nums，版本号位数变化也不跳）', () => {
    const html = renderDatasetsTable([fullDataset()]);
    const thead = /<thead[\s\S]*?<\/thead>/.exec(html)?.[0] ?? '';
    const thClasses = [...thead.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)].map((m) => ({
      className: /class="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
      text: (m[2] ?? '').replace(/<[^>]+>/g, '').replace(/，点击切换排序/g, '').trim(),
    }));
    for (const header of ['最新版本', '条目数', '最近更新']) {
      const cell = thClasses.find((c) => c.text === header);
      expect(cell, `${header} 表头应存在`).toBeDefined();
      expect(cell?.className, `${header} 必须是数字列`).toContain('num');
      expect(cell?.className, `${header} 必须右对齐`).toContain('text-right');
    }
  });

  it('列 id 唯一（DataTable 以 id 作列键，重名会静默丢列）', () => {
    const ids = datasetsTableColumns().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('单元格不折行（与 /runs 同一条：中文逐字折行会撑破 36px 行高）', () => {
    const html = renderDatasetsTable([fullDataset()]);
    const tbody = /<tbody[\s\S]*?<\/tbody>/.exec(html)?.[0] ?? '';
    const tdClasses = [...tbody.matchAll(/<td\b([^>]*)>/g)].map(
      (m) => /class="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
    );
    expect(tdClasses.length).toBeGreaterThan(0);
    for (const cls of tdClasses) expect(cls).toContain('whitespace-nowrap');
  });
});

// ---------------------------------------------------------------------------
// 2. 空值口径
// ---------------------------------------------------------------------------

describe('空值显示 — 而不是 0（无版本是合法状态）', () => {
  it('尚无版本：最新版本 = —、条目数 = —、来源 = —', () => {
    const rows = bodyRows(
      renderDatasetsTable([
        fullDataset({
          latestVersionNo: null,
          caseCount: null,
          latestSource: null,
        }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[1]).toBe('—');
    expect(rows[0]?.[2]).toBe('—');
    expect(rows[0]?.[3]).toBe('—');
  });

  it('真实的零条显示 0（不把 0 也伪装成 —）', () => {
    const rows = bodyRows(renderDatasetsTable([fullDataset({ caseCount: 0 })]));
    expect(rows[0]?.[2]).toBe('0');
  });

  it('来源三档映射正确', () => {
    const rows = bodyRows(
      renderDatasetsTable([
        fullDataset({ id: 'a', latestSource: 'import' }),
        fullDataset({ id: 'b', latestSource: 'mine' }),
        fullDataset({ id: 'c', latestSource: 'backflow' }),
      ]),
    );
    expect(rows.map((r) => r[3])).toEqual(['导入', '挖掘', '回流']);
  });
});

// ---------------------------------------------------------------------------
// 3. 行操作只有「查看版本」
// ---------------------------------------------------------------------------

describe('行操作仅「查看版本」（明确不做删除 / 导出）', () => {
  it('操作列只有一颗「查看版本」按钮', () => {
    const rows = bodyRows(renderDatasetsTable([fullDataset()]));
    expect(rows[0]?.[5]).toBe('查看版本');
  });

  it('源码里没有删除版本 / 导出 JSONL 的入口（不是藏起来，是根本不实现）', async () => {
    const src = await readFile(
      resolve(ROOT, 'components', 'datasets', 'datasets-table-columns.tsx'),
      'utf8',
    );
    // 只扫代码行，跳过注释：注释里会解释「明确不做删除/导出」，那是说明不是实现。
    const code = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/删除版本|导出\s*JSONL|onDelete|exportJsonl/i);
  });
});

// ---------------------------------------------------------------------------
// 4. 页面接线：列定义真的被用上，且数据来自 /api/datasets
// ---------------------------------------------------------------------------

describe('/datasets 页面接线', () => {
  it('页面使用抽出的列定义，数据来自 /api/datasets', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    expect(src).toContain('datasetsTableColumns');
    expect(src).toMatch(/useApi\(\s*DatasetListResponse\s*,\s*'\/api\/datasets\?limit=50'/);
    // 不得在组件里写死 Case 数组（[FE-02] DoD 最后一条）
    expect(src).not.toMatch(/const\s+\w+\s*=\s*\[\s*\{\s*case_key/);
  });

  it('版本历史是内联展开（[FE-02] 交付物 1「版本历史（内联展开预览）」）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    // 不跳页、不弹窗：展开态只是一个 state + 条件渲染
    expect(src).toMatch(/const \[expandedId, setExpandedId\] = React\.useState/);
    expect(src).not.toMatch(/router\.(push|replace)\(\s*[`'"]\/datasets\/\$\{/);
  });

  it('上传面板三件套齐全：文件 / 名称 / 校验结果区 / 生成新版本', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    expect(src).toContain('type="file"');
    expect(src).toContain('生成新版本');
    expect(src).toContain('校验');
    // 校验必须走服务端校验接口，不在前端自己解析
    expect(src).toContain('/api/datasets/imports/validate');
  });
});

// ---------------------------------------------------------------------------
// 6. 上传面板（[FE-02] 交付物 1 后半 + 交付物 2 校验结果区）
// ---------------------------------------------------------------------------

/**
 * 上传面板的三块在 `pages-and-flows.md` `PG-05` 区域 3 里写死：
 * 文件（JSONL / CSV）+ 名称 + 校验结果区（`通过 298 条 / 失败 2 条`，
 * 失败逐行列出，如 `第 47 行：缺少 case_key 且 input 为空`）→「生成新版本」。
 *
 * 这里的静态断言只锁「结构存在 + 校验必须走服务端」；真正的**行为**
 * （粘坏行 → 服务端返回 → 逐行渲染 → 按钮变灰）在下面的浏览器组里验。
 */
describe('[FE-02] 上传面板（结构 + 校验必须走服务端）', () => {
  it('三件套齐全：文件选择（接受 JSONL/CSV）、名称下拉、内容输入、生成新版本', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    expect(src).toContain('type="file"');
    expect(src).toMatch(/accept="[^"]*\.jsonl[^"]*"/);
    expect(src).toMatch(/accept="[^"]*\.csv[^"]*"/);
    expect(src).toContain('id="dataset-id"'); // 名称（目标评测集）
    expect(src).toContain('id="dataset-content"');
    expect(src).toContain('生成新版本');
  });

  it('校验走服务端接口，不在前端自己解析（行号口径只能有一处实现）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    expect(src).toContain('/api/datasets/imports/validate');
    // 前端不得出现 JSONL/CSV 解析逻辑（split('\n') + JSON.parse 逐行校验）
    expect(src).not.toMatch(/JSON\.parse\s*\(/);
    expect(src).not.toMatch(/split\(\s*['"]\\n['"]\s*\)/);
  });

  it('校验结果区用 importSummary + importIssueLine 渲染（文案不在组件里自造）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    expect(src).toContain('importSummary');
    expect(src).toContain('importIssueLine');
    expect(src).toContain('importBlockedReason');
  });

  it('「生成新版本」由 canCommit 门控，不是「有内容就能点」', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    expect(src).toContain('importCanCommit');
    expect(src).toMatch(/disabled=\{[^}]*!canCommit/);
  });
});

// ---------------------------------------------------------------------------
// 7. 版本历史（[FE-02] 交付物 1 末尾 + 交付物 3 不可变文案）
// ---------------------------------------------------------------------------

describe('[FE-02] 版本历史（内联展开 + 不可变文案）', () => {
  it('版本历史是内联展开，不跳页也不弹窗', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    // 展开态是页面 state，条件渲染，不是新路由或 Dialog
    expect(src).toMatch(/const \[expandedId, setExpandedId\] = React\.useState/);
    expect(src).toMatch(/\{expandedId === null \? null : \(\s*<VersionHistory/);
    expect(src).not.toMatch(/router\.(push|replace)/);
    expect(src).not.toMatch(/<Dialog|<Sheet/);
  });

  it('不可变提示走 versionFrozenNotice（版本号跟实际版本走，不写死 v3）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    expect(src).toContain('versionFrozenNotice');
    // 组件里不得出现写死的「版本 v3 已发布」
    expect(src).not.toContain('版本 v3 已发布');
  });

  it('版本行含 version_no / 条目数 / content_hash / 创建人 / 时间 / 预览', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'datasets', 'page.tsx'), 'utf8');
    for (const field of ['version.versionNo', 'version.caseCount', 'version.contentHash', 'version.createdBy', 'version.createdAt', '预览']) {
      expect(src, `版本行必须展示 ${field}`).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. 浏览器级几何（需要服务 + 本机 Edge）
// ---------------------------------------------------------------------------
async function apiDatasetCount(): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/api/datasets?limit=50`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: readonly unknown[] };
    return body.items?.length ?? 0;
  } catch {
    return null;
  }
}

const LIVE_ITEMS = await apiDatasetCount();
const LAUNCHER = await tryLocalChromium();

if (LIVE_ITEMS === null) {
  console.warn(
    `[datasets-render-parity] ${BASE} 无可用服务，浏览器对账已跳过；` +
      '合并前先 npm run dev:all，再 npm run test。',
  );
}

interface GeometryProbe {
  readonly rows: number;
  readonly wrappedCells: readonly { readonly col: number; readonly lines: number; readonly text: string }[];
  readonly docScrollWidth: number;
  readonly docClientWidth: number;
}

describe.skipIf(LIVE_ITEMS === null || LAUNCHER === null)(
  '布局几何 · /datasets 单元格不折行、文档不横向溢出（真实浏览器，1440）',
  () => {
    it(
      '每个单元格文本行数 = 设计行数（名称列允许 2 行），文档不横向溢出',
      async () => {
        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        let probe: GeometryProbe;
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try {
          await page.goto(`${BASE}/datasets`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1_200);

          probe = (await page.evaluate(`(() => {
            const rows = [...document.querySelectorAll('table tbody tr')];
            const wrappedCells = [];

            // 只数**文本节点**的行盒：徽章/图标是 inline-flex，与文本 top 不同。
            const textLineTops = (td) => {
              const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
              const tops = new Set();
              let node = walker.nextNode();
              while (node !== null) {
                if ((node.nodeValue || '').trim() !== '') {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  [...range.getClientRects()]
                    .filter((r) => r.height > 0)
                    .forEach((r) => tops.add(Math.round(r.top)));
                }
                node = walker.nextNode();
              }
              return tops.size;
            };

            rows.forEach((tr) => {
              [...tr.querySelectorAll('td')].forEach((td, col) => {
                const lines = textLineTops(td);
                // 名称列设计上是两行（名称 + 描述），其余列为单行。
                const designed = col === 0 ? 2 : 1;
                // 名称列没有描述时只有一行 —— 两种都合法，只禁止「超过设计行数」。
                if (lines > designed) {
                  wrappedCells.push({
                    col,
                    lines,
                    text: (td.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28),
                  });
                }
              });
            });

            return {
              rows: rows.length,
              wrappedCells,
              docScrollWidth: document.documentElement.scrollWidth,
              docClientWidth: document.documentElement.clientWidth,
            };
          })()`)) as GeometryProbe;
        } finally {
          await page.close();
        }

        expect(probe.rows, '页面必须有行可量（否则断言会空转成绿）').toBeGreaterThan(0);
        expect(
          probe.wrappedCells,
          `以下单元格行数超过设计（逐字折行会撑破 36px 行高）：${JSON.stringify(probe.wrappedCells)}`,
        ).toEqual([]);
        expect(
          probe.docScrollWidth,
          `文档横向溢出 ${String(probe.docScrollWidth)} > ${String(probe.docClientWidth)}`,
        ).toBeLessThanOrEqual(probe.docClientWidth);

        await browser.close();
      },
      120_000,
    );
  },
);

// ---------------------------------------------------------------------------
// 9. 浏览器级行为：上传面板校验 + 版本历史展开
// ---------------------------------------------------------------------------

interface PanelProbe {
  readonly hasFile: boolean;
  readonly accept: string;
  readonly hasSelect: boolean;
  readonly hasTextarea: boolean;
  readonly buttons: readonly string[];
}

describe.skipIf(LIVE_ITEMS === null || LAUNCHER === null)(
  '[FE-02] 上传面板与版本历史 · 真实浏览器行为',
  () => {
    it(
      '粘坏行 → 走服务端校验 → 逐行渲染「第 N 行：…」→ 生成新版本按钮变灰',
      async () => {
        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try {
          const validateHits: string[] = [];
          page.on('request', (req: { url: () => string }) => {
            const u = req.url();
            if (u.includes('/api/datasets/imports/validate')) validateHits.push(u);
          });

          await page.goto(`${BASE}/datasets`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1_200);

          // ---- 面板三件套 ----
          const panel = (await page.evaluate(`(() => {
            const fileInput = document.querySelector('input[type="file"]');
            const select = document.querySelector('#dataset-id');
            return {
              hasFile: fileInput !== null,
              accept: fileInput === null ? '' : fileInput.getAttribute('accept'),
              hasSelect: select !== null,
              hasTextarea: document.querySelector('#dataset-content') !== null,
              buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
            };
          })()`)) as PanelProbe;

          expect(panel.hasFile, '必须有文件选择框').toBe(true);
          expect(panel.accept, '文件选择框必须接受 .jsonl').toContain('.jsonl');
          expect(panel.accept, '文件选择框必须接受 .csv').toContain('.csv');
          expect(panel.hasSelect, '必须有目标评测集下拉').toBe(true);
          expect(panel.hasTextarea, '必须有可粘贴内容的输入区').toBe(true);
          expect(panel.buttons, '必须有「校验」').toContain('校验');
          expect(panel.buttons, '必须有「生成新版本」').toContain('生成新版本');

          // ---- 粘一份含坏行的 JSONL 并校验 ----
          const badJsonl = [
            '{"case_key":"ok-1","input":{"query":"FIXTURE-HIT-测试"},"reference":{"golden_answer":"a"}}',
            '{"case_key":"ok-2","input":{"query":"FIXTURE-HIT-测试2"},"reference":{"golden_answer":"b"}}',
            '{"input":{"query":""}}',
          ].join('\n');

          await page.evaluate(
            `(() => {
              const ta = document.querySelector('#dataset-content');
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value',
              ).set;
              setter.call(ta, ${JSON.stringify(badJsonl)});
              ta.dispatchEvent(new Event('input', { bubbles: true }));
            })()`,
          );
          await page.waitForTimeout(300);

          await page.locator('button', { hasText: '校验' }).first().click();
          await page.waitForTimeout(2_500);

          const result = (await page.evaluate(`(() => {
            const body = document.body.textContent || '';
            const m = /通过\\s*(\\d+)\\s*条\\s*\\/\\s*失败\\s*(\\d+)\\s*条/.exec(body);
            const lines = [...document.querySelectorAll('li')]
              .map((li) => (li.textContent || '').trim())
              .filter((t) => /^第\\s*\\d+\\s*行/.test(t));
            const commit = [...document.querySelectorAll('button')].find(
              (b) => (b.textContent || '').trim() === '生成新版本',
            );
            return {
              ok: m === null ? null : m[1],
              failed: m === null ? null : m[2],
              issueLines: lines,
              commitDisabled: commit === undefined ? null : commit.disabled,
            };
          })()`)) as {
            ok: string | null;
            failed: string | null;
            issueLines: string[];
            commitDisabled: boolean | null;
          };

          // 校验必须真的打了服务端接口 —— 否则「校验通过」可能只是前端假装。
          expect(validateHits.length, '校验必须调用 /api/datasets/imports/validate').toBeGreaterThan(0);

          // 2 条通过 / 1 条失败，逐行文案是「第 N 行：…」（N 是物理行号）
          expect(result.ok, '通过条数').toBe('2');
          expect(result.failed, '失败条数').toBe('1');
          expect(result.issueLines.length, '失败必须逐行渲染').toBeGreaterThan(0);
          expect(result.issueLines[0], '逐行文案必须是「第 N 行：…」').toMatch(/^第\s*\d+\s*行[：:]/);
          expect(result.issueLines[0], '坏行是第 3 行（物理行号，不是 0-based）').toContain('第 3 行');

          // 有坏行 ⇒ 「生成新版本」不可点（[FE-02] DoD：零通过不可点；
          // 部分失败时同样不可点，因为 canCommit 由服务端判定）
          expect(result.commitDisabled, '有失败行时「生成新版本」必须置灰').toBe(true);
        } finally {
          await page.close();
          await browser.close();
        }
      },
      180_000,
    );

    it(
      '「查看版本」内联展开版本历史；「预览」展开 Case 明细且顶部有不可变文案',
      async () => {
        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try {
          await page.goto(`${BASE}/datasets`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1_200);

          const urlBefore = await page.evaluate('location.pathname + location.search');

          /**
           * 用**接口**挑一个「有版本」的评测集，再在 DOM 里按**名称**定位它的行。
           *
           * 为什么不能用 `.first()` + 硬编码 20：
           *  - 列表接口是 `ORDER BY d.created_at DESC`，`scripts/e2e-demo.ts` 造的
           *    50 条集**新建更晚、排在最前**，于是 `.first()` 指向的不是种子集。
           *    之前这里写死 `rows === 20`，在有 e2e 数据的环境下必红
           *    （这是独立验收的 D-1 阻塞项）。
           *  - 断言的目标不是「某个数字」，而是**「预览渲染的行数 === 该版本声明的条数」**。
           *    声明值从**版本行自己的文案**里读（页面渲染的 `N 条`），
           *    这样无论谁排第一、版本是多少条，都成立。
           */
          const datasetsApi = (await (
            await fetch(`${BASE}/api/datasets?limit=50`, { signal: AbortSignal.timeout(3000) })
          ).json()) as {
            items: readonly {
              readonly name: string;
              readonly latestVersionNo: number | null;
            }[];
          };
          const target = datasetsApi.items.find((d) => d.latestVersionNo !== null);
          expect(target, '至少要有一个已导入版本的评测集才能测版本历史').toBeDefined();
          const targetName = target?.name ?? '';
          const latestVersionNo = target?.latestVersionNo ?? 0;

          // ---- 展开版本历史（按名称定位行，不用 .first()） ----
          const row = page.locator('table tbody tr', { hasText: targetName }).first();
          expect(await row.count(), `评测集「${targetName}」必须出现在列表里`).toBe(1);
          await row.first().locator('button', { hasText: '查看版本' }).click();
          await page.waitForTimeout(1_500);

          const history = (await page.evaluate(`(() => {
            const t = document.body.textContent || '';
            return { hasTitle: t.includes('版本历史') };
          })()`)) as { hasTitle: boolean };

          expect(history.hasTitle, '点「查看版本」应展开「版本历史」区块').toBe(true);

          // 内联展开：URL 不变（不跳页）
          const urlAfter = await page.evaluate('location.pathname + location.search');
          expect(urlAfter, '展开版本历史不得改变 URL（内联展开，不是新路由）').toBe(urlBefore);
          expect(urlAfter, 'URL 必须仍在 /datasets').toBe('/datasets');

          // 不得弹窗（不出现 dialog）
          const dialogCount = await page.locator('[role="dialog"]').count();
          expect(dialogCount, '版本历史不得用弹窗').toBe(0);

          // ---- 在指定版本行上点「预览」，并读该行声明的条目数 ----
          //
          // ⚠️ 定位极易错，踩过两次：
          //  1. `locator('li', { hasText: 'v1' })` 会先命中**侧栏导航**的 `<li>`
          //     （评测运行台 / 发起评测 / …），读到空文案。实测 `declared` 就是这么变成 undefined 的。
          //  2. `locator('li.flex-col', { hasText: 'v1' })` 的 hasText 是**子串**匹配，
          //     仍可能命中别的容器。
          //
          // 改为：等「版本行真的渲染出来」（页面上出现独立的 `N 条` span），
          // 再用 `page.evaluate` 在 DOM 里按结构挑那个 li —— 判据是
          // 「该 li 内部有一个 span 的文案恰好是 `N 条`」，这是 `VersionRow` 的固定结构。
          await page.waitForTimeout(1_000);

          const versionRowInfo = (await page.evaluate(`(() => {
            const all = [...document.querySelectorAll('li')];
            const hit = all.find((li) => {
              const spans = [...li.querySelectorAll('span')];
              return spans.some((s) => /^\\s*\\d+\\s*条\\s*$/.test(s.textContent || ''));
            });
            if (hit === undefined) return null;
            const spans = [...hit.querySelectorAll('span')];
            const countSpan = spans.find((s) => /^\\s*\\d+\\s*条\\s*$/.test(s.textContent || ''));
            const versionSpan = spans.find((s) => /^\\s*v\\d+\\s*$/.test(s.textContent || ''));
            return {
              declared: countSpan === undefined ? null : Number((countSpan.textContent || '').replace(/\\D/g, '')),
              versionNo: versionSpan === undefined ? null : Number((versionSpan.textContent || '').replace(/\\D/g, '')),
              // 该 li 在 li 列表里的末尾位置（版本历史区在页面末尾，用它定位点击）
              ok: true,
            };
          })()`)) as { declared: number | null; versionNo: number | null; ok: boolean } | null;

          expect(versionRowInfo, '版本历史里必须渲染出带 `N 条` 的版本行').not.toBeNull();
          const declared = versionRowInfo?.declared ?? null;
          const renderedVersionNo = versionRowInfo?.versionNo ?? latestVersionNo;
          expect(declared, '版本行必须声明条目数（独立的 `N 条` 片段）').not.toBeNull();
          expect(declared ?? 0, '声明的条数必须是正整数').toBeGreaterThan(0);

          // 点该版本行里的「预览」。
          // 用「`li` 里的 `预览` 按钮」定位：侧栏导航的 `li` 里没有「预览」，
          // 全页唯一的「预览」在版本行内，因此不会误命中。
          await page.locator('li button', { hasText: '预览' }).first().click();
          await page.waitForTimeout(1_500);

          const preview = (await page.evaluate(`(() => {
            const tables = [...document.querySelectorAll('table')];
            const inner = tables.length < 2 ? null : tables[tables.length - 1];
            const t = document.body.textContent || '';
            return {
              hasInner: inner !== null,
              headers:
                inner === null
                  ? []
                  : [...inner.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim()),
              rows: inner === null ? 0 : inner.querySelectorAll('tbody tr').length,
              frozen:
                (t.match(/版本 v\\d+ 已发布，不可修改。如需调整数据，请导入并生成新版本。/) || [''])[0],
            };
          })()`)) as {
            hasInner: boolean;
            headers: string[];
            rows: number;
            frozen: string;
          };

          expect(preview.hasInner, '预览应渲染内层 Case 明细表').toBe(true);
          expect(preview.headers, '预览表列 = Seq / Case Key / Query / 检索标注').toEqual([
            'Seq',
            'Case Key',
            'Query',
            '检索标注',
          ]);

          // ★ 核心断言：预览行数 === 该版本声明的条数（不硬编码任何数字）
          expect(
            preview.rows,
            `预览渲染 ${String(preview.rows)} 行，但 v${String(renderedVersionNo)} 声明 ${String(declared)} 条`,
          ).toBe(declared);

          // 不可变提示：**版本号跟着实际版本走**
          expect(preview.frozen, '版本预览顶部必须有不可变文案').not.toBe('');
          expect(preview.frozen, '文案逐字取自 pages-and-flows.md').toContain('已发布，不可修改');
          expect(preview.frozen, `版本号必须是实际展开的 v${String(renderedVersionNo)}`).toContain(
            `版本 v${String(renderedVersionNo)} 已发布`,
          );
        } finally {
          await page.close();
          await browser.close();
        }
      },
      180_000,
    );
  },
);
