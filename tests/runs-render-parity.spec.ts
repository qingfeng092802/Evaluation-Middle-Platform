/**
 * `PG-01` 列表口径（`SPEC-M1` `[FE-03]` 交付物 1）+ **`B-02` 补丁的 P1 版**。
 *
 * 这里锁死三件「写错了也照常渲染」的事：
 *
 *  1. **列集合**：`[FE-03]` 交付物 1 逐字列了 8 列，再加 `SPEC-M1` §6.5 `T-2`
 *     裁定的「准出门禁」列。少一列 / 多一列 / 换个表头，页面照样能跑，
 *     只有对着原文断言才拦得住。
 *
 *  2. **准出门禁恒为「未评估」**：`gate_evaluations` 在 M1 是空表（`SPEC-M1` §1.1）。
 *     最危险的走样是「按 `status === 'COMPLETED'` 推出准出」——页面看起来更完整，
 *     但那是对用户的谎言（`T-2` 三禁：不填假值、不派生猜测、不隐藏列）。
 *     因此这里**用真实 `DataTable` 渲染一条满分的 COMPLETED 运行**
 *     再读出门禁单元格；只断言 `<GateBadge />` 的静态 HTML 抓不到这类派生，
 *     因为派生逻辑会写在列定义里而不是徽章里。
 *
 *  3. **`B-02` 补丁**：`/api/runs` 返回 N 条 ⇒ `/runs` 表格渲染 N 行。
 *     2026-11-09 的事故里每一层单测都是绿的（接口有 3 条、`DataTable` 给 3 条渲染
 *     3 行），但真实页面是 0 行 —— 断在层与层之间（chunk 404 ⇒ 不水合）。
 *     因此这条必须**打真实 HTTP + 真实浏览器**，且必须进仓库测试，
 *     不能只留在 `scripts/` 的验收脚本里（需求方 2026-11-10 指令）。
 *
 * 浏览器层需要跑着的服务与本机 Edge。条件不满足时**跳过并显式打印原因**
 * （跳过 ≠ 通过）：合并前必须 `npm run dev:all` 之后重跑一遍。
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EvalRun } from '@eval-platform/contracts';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DataTable } from '../components/ui/data-table';
import { runsTableColumns } from '../components/runs/runs-table-columns';
import { judgeRenderParity, PARITY_PAGES } from '../scripts/check-datasets-render.js';
import { EDGE_PATH, tryLocalChromium } from '../scripts/pw-local.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env['PG_BASE'] ?? 'http://127.0.0.1:3000';

/** 一条「看起来最该被判定准出」的运行：已完成、满分、零失败。 */
function perfectCompletedRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: '客服QA回归 · 满分',
    status: 'COMPLETED',
    datasetVersionId: '22222222-2222-4222-8222-222222222222',
    targetVersionId: '33333333-3333-4333-8333-333333333333',
    datasetLabel: '客服QA评测集 @ v3',
    targetLabel: 'gpt-4o · 主路由',
    concurrency: 4,
    counts: { totalCases: 20, succeededCases: 20, failedCases: 0, skippedCases: 0 },
    metrics: {
      scoreOverall: 1,
      passRate: 1,
      coverage: 1,
      latencyP50Ms: 320,
      latencyP95Ms: 880,
      tokensInTotal: 12_000,
      tokensOutTotal: 4_000,
      costTarget: 0.42,
      costJudge: 0.08,
      costTotal: 0.5,
    },
    triggerSource: 'MANUAL',
    baselineRunId: null,
    createdBy: '张工',
    createdAt: '2026-11-10T08:00:00.000Z',
    startedAt: '2026-11-10T08:00:01.000Z',
    finishedAt: '2026-11-10T08:00:42.000Z',
    cancelRequestedAt: null,
    ...overrides,
  };
}

/** 用真实 `DataTable` 渲染给定行，返回静态 HTML。 */
function renderRunsTable(rows: readonly EvalRun[]): string {
  return renderToStaticMarkup(
    React.createElement(DataTable<EvalRun>, {
      columns: runsTableColumns,
      rows,
      getRowId: (r: EvalRun) => r.id,
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
// 1. 列集合（对着渲染出的表头断言，而不是对着源码正则）
// ---------------------------------------------------------------------------

describe('/runs 列集合 · 逐字对齐 SPEC-M1 [FE-03] 交付物 1', () => {
  it('表头 = 交付物 1 的 8 列（门禁列在「发起时间」之后、「操作」之前）', () => {
    const html = renderRunsTable([perfectCompletedRun()]);
    expect(headerCells(html)).toEqual([
      '评测名称',
      '状态',
      '综合得分',
      '耗时',
      'Token 成本',
      '发起人',
      '发起时间',
      '准出门禁',
      '操作',
    ]);
  });

  it('没有 SPEC 之外的自造「Token」列，但「Token 成本」必须在', () => {
    const headers = headerCells(renderRunsTable([perfectCompletedRun()]));
    expect(headers).not.toContain('Token');
    expect(headers).toContain('Token 成本');
  });

  it('四个数字列右对齐且带 .num（tabular-nums，小数点垂直对齐）', () => {
    const html = renderRunsTable([perfectCompletedRun()]);
    const thead = /<thead[\s\S]*?<\/thead>/.exec(html)?.[0] ?? '';
    const thClasses = [...thead.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)].map((m) => ({
      className: /class="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
      text: (m[2] ?? '').replace(/<[^>]+>/g, '').replace(/，点击切换排序/g, '').trim(),
    }));
    for (const header of ['综合得分', '耗时', 'Token 成本', '发起时间']) {
      const cell = thClasses.find((c) => c.text === header);
      expect(cell, `${header} 表头应存在`).toBeDefined();
      expect(cell?.className, `${header} 必须是数字列`).toContain('num');
      expect(cell?.className, `${header} 必须右对齐`).toContain('text-right');
    }
  });

  it('列 id 唯一（DataTable 以 id 作列键，重名会静默丢列）', () => {
    const ids = runsTableColumns.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('单元格不折行：否则中文在窄列里逐字折成「已完 / 成」并撑破 36px 行高', () => {
    const html = renderRunsTable([perfectCompletedRun()]);
    const tbody = /<tbody[\s\S]*?<\/tbody>/.exec(html)?.[0] ?? '';
    const tdClasses = [...tbody.matchAll(/<td\b([^>]*)>/g)].map(
      (m) => /class="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
    );
    expect(tdClasses.length).toBeGreaterThan(0);
    for (const cls of tdClasses) {
      // 表头早已 `whitespace-nowrap`，body 漏了就会出现「状态」「操作」列被挤成两行；
      // 需要截断的列自己用 `.truncate`（内含 nowrap），不受这条影响。
      expect(cls).toContain('whitespace-nowrap');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 准出门禁列：恒为「未评估」
// ---------------------------------------------------------------------------

describe('准出门禁 · M1 恒为「未评估」，不派生、不猜测（SPEC §6.5 T-2）', () => {
  const GATE_COL = 7; // 由第 1 组的表头断言固定

  it('满分 COMPLETED 运行：门禁仍是「未评估」，不推出「准出」', () => {
    const rows = bodyRows(renderRunsTable([perfectCompletedRun()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[GATE_COL]).toBe('未评估');
    expect(rows[0]?.[GATE_COL]).not.toBe('PASS 准出');
    expect(rows[0]?.[GATE_COL]).not.toBe('BLOCK 阻断');
  });

  it('FAILED / RUNNING / PARTIAL_FAILED 一律「未评估」——门禁与运行状态无关', () => {
    const rows = bodyRows(
      renderRunsTable([
        perfectCompletedRun({ id: 'a0000000-0000-4000-8000-000000000001', status: 'FAILED' }),
        perfectCompletedRun({ id: 'a0000000-0000-4000-8000-000000000002', status: 'RUNNING' }),
        perfectCompletedRun({
          id: 'a0000000-0000-4000-8000-000000000003',
          status: 'PARTIAL_FAILED',
        }),
      ]),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row[GATE_COL]).toBe('未评估');
  });

  it('门禁单元格不带 pass/fail 语义色（用色即等于下了一个 M1 无权下的裁决）', () => {
    const html = renderRunsTable([perfectCompletedRun()]);
    const tbody = /<tbody[\s\S]*?<\/tbody>/.exec(html)?.[0] ?? '';
    const gateCellHtml =
      [...tbody.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][GATE_COL]?.[1] ?? '';
    expect(gateCellHtml).toContain('未评估');
    for (const cls of ['text-eval-pass', 'text-eval-fail', 'bg-eval-pass-bg', 'bg-eval-fail-bg']) {
      expect(gateCellHtml, `门禁单元格不得含 ${cls}`).not.toContain(cls);
    }
  });

  it('门禁列不可排序：整列同值，可点而无反应比不可点更糟', () => {
    const gate = runsTableColumns.find((c) => c.id === 'gate');
    expect(gate).toBeDefined();
    expect(gate?.sortValue).toBeUndefined();
  });

  it('门禁列不接受行数据：单元格函数对任何行都返回同一个徽章', () => {
    const gate = runsTableColumns.find((c) => c.id === 'gate');
    expect(gate).toBeDefined();
    const a = renderToStaticMarkup(gate?.cell(perfectCompletedRun()) as React.ReactElement);
    const b = renderToStaticMarkup(
      gate?.cell(perfectCompletedRun({ status: 'FAILED', metrics: { ...perfectCompletedRun().metrics, scoreOverall: null } })) as React.ReactElement,
    );
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 3. 空状态与横幅（交付物 1 的另外两块）
// ---------------------------------------------------------------------------

describe('空状态与会话内固定文案', () => {
  it('0 行 ⇒ 渲染「还没有评测记录。」与两个出口，而不是空表格', () => {
    const html = renderRunsTable([]);
    // 无 emptyKey 时 DataTable 渲染空表头；页面传了 emptyKey='runs'，这里单独验文案。
    const withEmpty = renderToStaticMarkup(
      React.createElement(DataTable<EvalRun>, {
        columns: runsTableColumns,
        rows: [],
        getRowId: (r: EvalRun) => r.id,
        emptyKey: 'runs',
      }),
    );
    expect(withEmpty).toContain('还没有评测记录。');
    expect(withEmpty).toContain('去导入评测集');
    expect(withEmpty).toContain('去创建待测目标');
    expect(withEmpty).not.toContain('<tbody');
    expect(html).toBeTruthy();
  });

  it('页面源码：横幅在列表之前、空态用 emptyKey="runs"、不渲染聚合指标卡', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', 'page.tsx'), 'utf8');
    expect(src).toContain('<ProviderBanner');
    // 只看 `<DataTable ... />` 这一段：注释里也会出现 `emptyKey="runs"`，
    // 拿整个文件去 `toContain` 会被说明文字蒙混过去。
    const tableBlock = /<DataTable<EvalRun>[\s\S]*?\/>/.exec(src)?.[0] ?? '';
    expect(tableBlock).not.toBe('');
    expect(tableBlock).toContain('emptyKey="runs"');
    // 横幅必须排在表格前面（`[FE-03]`：「未配凭证横幅」是前置提示）。
    expect(src.indexOf('<ProviderBanner')).toBeLessThan(src.indexOf('<DataTable'));
    // M1 不加 KPI 行（§6.5 T-1）：指标卡只在详情页出现，列表页不得聚合出通过率之类。
    // 断言的是**结构**（是否引入指标卡渲染 / KPI 栅格），不是关键字 ——
    // 注释里提到「不加 KPI」是正常的，扫字符串会把说明文字当成实现。
    expect(src).not.toContain('metricCardsOf');
    expect(src).not.toMatch(/grid-cols-[24]\s+lg:grid-cols-4/);
  });
});

// ---------------------------------------------------------------------------
// 4. B-02 补丁：渲染对账必须覆盖 /runs
// ---------------------------------------------------------------------------

describe('B-02 补丁 · 渲染对账表覆盖 /runs', () => {
  it('PARITY_PAGES 里有 /runs ↔ /api/runs（少了这一条，P1 就可能退化成「有数据渲染 0 行」）', () => {
    const entry = PARITY_PAGES.find((p) => p.route === '/runs');
    expect(entry).toBeDefined();
    // 页面自己用 `?limit=50`，对账必须打同一个查询，否则条数没有可比性。
    expect(entry?.apiPath).toBe('/api/runs?limit=50');
  });

  it('对账清单与 /runs 页面实际使用的查询串一致（防止两边各写一份然后漂移）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', 'page.tsx'), 'utf8');
    const used = /useApi\([^,]+,\s*'([^']+)'/.exec(src)?.[1];
    expect(used).toBe(PARITY_PAGES.find((p) => p.route === '/runs')?.apiPath);
  });

  it('接口 3 条 / 渲染 0 行 ⇒ 判失败（空表不能伪装成「还没有评测记录」）', () => {
    const issues = judgeRenderParity({ apiItems: 3, renderedRows: 0, statusCount: 0 });
    expect(issues.map((i) => i.code)).toEqual(['ROWS_MISMATCH']);
  });
});

// ---------------------------------------------------------------------------
// 5. B-02 补丁：真实浏览器对账（需要服务 + 本机 Edge）
// ---------------------------------------------------------------------------

async function apiItemCount(apiPath: string): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}${apiPath}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: readonly unknown[] };
    return body.items?.length ?? 0;
  } catch {
    return null;
  }
}

const RUNS_PAGE = PARITY_PAGES.find((p) => p.route === '/runs');
const LIVE_ITEMS = RUNS_PAGE === undefined ? null : await apiItemCount(RUNS_PAGE.apiPath);
const LAUNCHER = await tryLocalChromium();

if (LIVE_ITEMS === null) {
  console.warn(
    `[runs-render-parity] ${BASE} 无可用服务，浏览器对账已跳过；` +
      '合并前先 npm run dev:all，再 npm run test。',
  );
}

describe.skipIf(LIVE_ITEMS === null || LAUNCHER === null)(
  'B-02 补丁 · 真实浏览器：/api/runs 的 N 条 ⇒ /runs 的 N 行',
  () => {
    it(
      '浏览器渲染行数 === 接口条数，且屏幕阅读器计数一致',
      async () => {
        const apiItems = LIVE_ITEMS ?? 0;

        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        let renderedRows = 0;
        let statusCount = 0;
        try {
          const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
          await page.goto(`${BASE}/runs`, { waitUntil: 'networkidle' });
          // 水合 + 首帧请求都在 networkidle 之后；再留一点余量给 React 提交。
          await page.waitForTimeout(1_500);

          renderedRows = await page.$$eval('table tbody tr', (els) => els.length);
          statusCount = await page.evaluate(() => {
            const el = document.querySelector('span[role="status"]');
            const m = /共\s*(\d+)\s*条记录/.exec(el?.textContent ?? '');
            return m === null ? 0 : Number(m[1]);
          });
        } finally {
          await browser.close();
        }

        // 与 scripts/check-datasets-render.ts 共用同一份判定，避免两套口径。
        expect(judgeRenderParity({ apiItems, renderedRows, statusCount })).toEqual([]);
      },
      120_000,
    );
  },
);

// ---------------------------------------------------------------------------
// 6. 布局几何：单元格折行与横向溢出（只有真实浏览器才看得见）
// ---------------------------------------------------------------------------

/**
 * 这两条断言存在的理由，是它们**曾经真实发生过**、而且单元测试全绿：
 *
 *  - 中文在窄列里**逐字**折行（「已完 / 成」「查看报 / 告」「未评 / 估」），
 *    把一个 36px 的行撑成 45px，整个列表的密度全乱；
 *  - 名称列在 `table-layout: auto` 下撑到 431px，表格 1187px 挤进 1172px 容器，
 *    最后一列「操作」被推出视口。
 *
 * 断言一个 `class` 字符串（`expect(cls).toContain('whitespace-nowrap')`）**证明不了**
 * 布局没崩 —— 类名写着但被别的规则盖掉、或宽度上限缺失导致溢出，都是绿的。
 * 所以这里量**真实几何**：文本行盒数与容器 `scrollWidth`。
 *
 * 实测数据（1440×900，1 条 run）：
 *
 *  | 状态 | 折行单元格 | 表格 scrollWidth / clientWidth |
 *  |---|---|---|
 *  | 两处修复都移除 | 6 个（列 0/1/3/6/7/8） | 1172 / 1172（此时不溢出，见下） |
 *  | 只移除 `whitespace-nowrap` | 1 个（列 0，设计如此） | 1172 / 1172 |
 *  | 只移除 `max-w-[22rem]` | 1 个（列 0，设计如此） | **1187 / 1172（溢出）** |
 *  | 两处都在（交付态） | 1 个（列 0，设计如此） | 1172 / 1172 |
 *
 * **注意第 2 行**：只拆掉 `whitespace-nowrap` 时**看不到**折行 —— 因为
 * `max-w-[22rem]` 把名称列压窄后，其余列都有余量，不会挤到需要折行。
 * 两处修复互相掩护，这正是「必须回到两者都不存在的状态才拿得到 RED」的原因。
 * 第 3 行则说明溢出这一条与 `whitespace-nowrap` 无关，是独立的宽度上限问题。
 */
interface GeometryProbe {
  readonly rows: number;
  readonly wrappedCells: readonly {
    readonly col: number;
    readonly lines: number;
    readonly text: string;
  }[];
  readonly tableScrollWidth: number;
  readonly tableClientWidth: number;
  readonly docScrollWidth: number;
  readonly docClientWidth: number;
}

/** 名称列（第 0 列）**设计上就是两行**：主名称 + 「评测集 · 目标」副标题。 */
const NAME_COL = 0;
const NAME_COL_DESIGNED_LINES = 2;

/**
 * 几何断言需要页面上**至少有一行**可量。
 *
 * 种子库里 `eval_runs` 是空的（种子刻意不种 run —— 要由页面真实创建），
 * 此时 `/runs` 渲染的是空状态，没有 `tbody tr`。这不是缺陷，是**环境前置不足**：
 * 拿一个空表去量列宽/折行，只能得到空集，断言会「因为没东西可量」而假绿 ——
 * 比失败更糟。因此这种情况必须**显式跳过并打印原因**（跳过 ≠ 通过）。
 *
 * 合并前要在「有至少一条已完成的 run」的环境下重跑一遍。
 */
const HAS_RUN_ROWS = (LIVE_ITEMS ?? 0) > 0;
if (LIVE_ITEMS !== null && !HAS_RUN_ROWS) {
  console.warn(
    '[runs-render-parity] /api/runs 返回 0 条，几何断言（折行/溢出）已跳过；' +
      '种子库不种 run，先跑一条评测再 npm run test（跳过 ≠ 通过）。',
  );
}

describe.skipIf(LIVE_ITEMS === null || LAUNCHER === null || !HAS_RUN_ROWS)(
  '布局几何 · 单元格不折行、表格不横向溢出（真实浏览器）',
  () => {
    it(
      '每个单元格的文本行数等于其设计行数，且表格与文档都不横向溢出（1440 与 1024 两档）',
      async () => {
        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        /**
         * 视口两档，但**两档断言的东西不一样**，这一点必须写清楚，否则会写出假绿：
         *
         * | 视口 | 容器可用宽 | 表格自然宽 | 该不该横向滚动 |
         * |---|---|---|---|
         * | 1440 | 1172 | 1172（有 `max-w`）/ 1189（无） | **不该**：放得下 |
         * | 1024 | 756 | 1133 | **该**：容器真的不够宽 |
         *
         * 所以：
         *  - **不折行**两档都断言 —— 这是 `whitespace-nowrap` 的职责，且**只在 1024
         *    可观测**：1440 下 `max-w-[22rem]` 已把各列压进 1172px，中文不需要折行，
         *    拆掉 `whitespace-nowrap` 也测不出来（见上面组合表第 3 行）。
         *    若只跑 1440，这条 RED 就永远拿不到。
         *  - **表格不溢出容器**只在 1440 上断言：1440 下溢出意味着名称列无上限导致
         *    多占 43px，是缺陷；1024 下容器确实不够宽，`overflow-x-auto` 存在的意义
         *    就是此时横向滚动，判它失败等于要求「永远不能滚动」。
         *  - **文档级横向溢出**只在 1440 断言。1024 下 `/runs`、`/datasets` 的文档
         *    会被撑宽（实测 `/runs` 1337/1024、`/datasets` 1069/1024），这是**全站既有
         *    缺陷**，与本批无关，已单独登记为 `SPEC-M1` §6.5 `T-5`，本批不修也不断言。
         */
        const VIEWPORTS = [
          { width: 1440, height: 900, expectTableFits: true, expectDocFits: true },
          { width: 1024, height: 900, expectTableFits: false, expectDocFits: false },
        ] as const;

        for (const viewport of VIEWPORTS) {
          let probe: GeometryProbe;
          {
            const page = await browser.newPage({ viewport });
            try {
              await page.goto(`${BASE}/runs`, { waitUntil: 'networkidle' });
              await page.waitForTimeout(1_200);

            // 函数体用字符串传入：tsx（esbuild `keepNames`）会给具名函数插入
            // `__name(...)`，而浏览器上下文没有这个 helper，会报 `__name is not defined`。
            probe = (await page.evaluate(`(() => {
              const rows = [...document.querySelectorAll('table tbody tr')];
              const wrappedCells = [];

              // 行盒必须只数**文本节点**：徽章是 inline-flex，svg 图标与文本的 top
              // 不同，按元素 rect 数会把「图标 + 文字」误判成两行。
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
                  const designed = col === ${String(NAME_COL)} ? ${String(NAME_COL_DESIGNED_LINES)} : 1;
                  if (lines !== designed) {
                    wrappedCells.push({
                      col,
                      lines,
                      text: (td.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28),
                    });
                  }
                });
              });

              const scroller = document.querySelector('div.overflow-x-auto');
              return {
                rows: rows.length,
                wrappedCells,
                tableScrollWidth: scroller === null ? -1 : scroller.scrollWidth,
                tableClientWidth: scroller === null ? -1 : scroller.clientWidth,
                docScrollWidth: document.documentElement.scrollWidth,
                docClientWidth: document.documentElement.clientWidth,
              };
            })()`)) as GeometryProbe;
            } finally {
              // 用 `close` 关闭本档页面，避免两档互相污染布局状态
              // （`playwright-core` 这里只用到 `newPage` / `PwPage.close`）。
              await page.close();
            }
          }

          const at = `${String(viewport.width)}px`;

          expect(probe.rows, `${at}：页面必须有行可量（否则断言会空转成绿）`).toBeGreaterThan(0);

          expect(
            probe.wrappedCells,
            `${at}：以下单元格行数与设计不符（逐字折行会撑破 36px 行高）：${JSON.stringify(probe.wrappedCells)}`,
          ).toEqual([]);

          // 表格是否该放得下、文档是否该被撑宽，都取决于视口（见上表）。
          if (viewport.expectTableFits) {
            expect(
              probe.tableScrollWidth,
              `${at}：容器本应放得下，却横向溢出 ${String(probe.tableScrollWidth)} > ${String(probe.tableClientWidth)}`,
            ).toBeLessThanOrEqual(probe.tableClientWidth);
          }

          if (viewport.expectDocFits) {
            expect(
              probe.docScrollWidth,
              `${at}：文档横向溢出 ${String(probe.docScrollWidth)} > ${String(probe.docClientWidth)}` +
                '（表格应在自己的滚动容器里滚，不该顶出页面级横向滚动条）',
            ).toBeLessThanOrEqual(probe.docClientWidth);
          }
        }

        await browser.close();
      },
      180_000,
    );
  },
);
