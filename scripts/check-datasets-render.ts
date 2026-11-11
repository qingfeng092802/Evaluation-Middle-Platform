#!/usr/bin/env tsx
/**
 * `B-02` 的**跨层对账**：接口返回 N 条 ⇒ 页面表格必须渲染 N 行。
 *
 * 覆盖页面的清单集中在 `PARITY_PAGES`（`/datasets`、`/runs`），
 * 浏览器层用本机 Edge + `scripts/pw-local.ts`（不新增依赖，见该文件说明）。
 *
 * ## 为什么单测不够
 *
 * 2026-11-09 的事故里每一层单独看都是绿的：接口 200 有 3 条；
 * `DataTable` 给 3 条能渲染 3 行（`tests/data-table-render.spec.ts` 已锁）；
 * 但在真实页面上，表格里有 **0 行**、并且显示「还没有评测集」。
 * 断掉的是层与层之间 —— 客户端 chunk 404、没有水合，`useApi` 的数据进不了组件。
 *
 * 所以这条检查必须打**真实 HTTP**：拿列表接口的条数，去比
 * 页面在浏览器里实际渲染出的 `<tbody><tr>` 数。两者不等就是回归。
 *
 * ## 为什么用浏览器而不只是抓 HTML
 *
 * 服务端渲染的 HTML 里可能是空表（首帧 `loading`），数据要等客户端水合后才进来。
 * 只抓 HTML 会把「水合坏了」误判成「正常」。真实浏览器等 `networkidle` 之后再数，
 * 才等价于用户在屏幕上看得到的东西。
 *
 * ## 依赖
 *
 * 用本机 Edge + npx 缓存里的 `playwright-core`（项目**不新增 devDependency**，
 * 与 `scripts/pg-interaction-check.ts` 同一口径，符合「构建期不联网」）。
 *
 * 用法：
 *     npx tsx scripts/check-datasets-render.ts            # 默认 http://127.0.0.1:3000
 *     npx tsx scripts/check-datasets-render.ts http://127.0.0.1:3100
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EDGE_PATH,
  tryLocalChromium,
  type PwBrowser,
} from './pw-local.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env['RENDER_BASE'] ?? process.argv[2] ?? 'http://127.0.0.1:3000';

// ---------------------------------------------------------------------------
// 纯判定（被 tests/data-table-render.spec.ts 直接引用，脚本与测试共用一份口径）
// ---------------------------------------------------------------------------

export type RenderParityCode = 'ROWS_MISMATCH' | 'STATUS_MISMATCH';

export interface RenderParityIssue {
  readonly code: RenderParityCode;
  readonly message: string;
}

export interface RenderParityInput {
  /** 对账接口返回的 `items.length`。 */
  readonly apiItems: number;
  /** 浏览器里 `<table> tbody tr` 的实际数量。 */
  readonly renderedRows: number;
  /** 表格屏幕阅读器计数（`role="status"` 的「共 N 条记录」）解析出的 N；无表格时为 0。 */
  readonly statusCount: number;
}

/**
 * 需要跨层对账的「列表页 ↔ 列表接口」配对。
 *
 * 为什么是表而不是单个常量：`B-02` 事故是**一类**问题（服务端有数据、页面渲染 0 行），
 * 只要新增一张列表就有一次重新踩坑的机会。把配对集中在这里，
 * 新增页面时**只改一行**，测试（`tests/runs-render-parity.spec.ts`）与脚本同时覆盖到，
 * 不会出现「测试只盯着 datasets，runs 悄悄退化」。
 *
 * `apiPath` 必须与页面里的 `useApi(...)` 参数**逐字一致**（含 `?limit=50`），
 * 否则条数没有可比性 —— 这正是 `runs` 页面自己会踩的坑。
 */
export interface ParityPage {
  readonly route: string;
  readonly apiPath: string;
}

export const PARITY_PAGES: readonly ParityPage[] = [
  { route: '/datasets', apiPath: '/api/datasets?limit=50' },
  { route: '/runs', apiPath: '/api/runs?limit=50' },
];

/**
 * 判定渲染是否与接口一致。空数组 = 通过。
 *
 * 两种失败分开报，因为处置不同：
 *  - `ROWS_MISMATCH`：数据没进表格 —— 水合 / 请求 / 组件任一处断了；
 *  - `STATUS_MISMATCH`：行数与屏幕阅读器计数不一致 —— 表格半渲染，或旧的
 *    「共 N 条」残留没更新，两个数不可能同时正确。
 *
 * 注意这里**双向**比较：接口 2 条却渲染 5 行同样是错（重复行 / 旧帧未清），
 * 只在「渲染少了」时报警会漏掉这类残留。
 */
export function judgeRenderParity(input: RenderParityInput): readonly RenderParityIssue[] {
  const issues: RenderParityIssue[] = [];

  if (input.renderedRows !== input.apiItems) {
    issues.push({
      code: 'ROWS_MISMATCH',
      message:
        `接口返回 ${String(input.apiItems)} 条，表格实际渲染 ${String(input.renderedRows)} 行。` +
        (input.apiItems > 0 && input.renderedRows === 0
          ? ' 有数据却渲染 0 行：先查 .next 是否混合产物（npm run check:next-artifacts），再查客户端水合。'
          : ''),
    });
  }

  if (input.statusCount !== input.renderedRows) {
    issues.push({
      code: 'STATUS_MISMATCH',
      message: `表格屏幕阅读器计数为 ${String(input.statusCount)}，实际行数为 ${String(input.renderedRows)}。`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 浏览器侧
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chromium = await tryLocalChromium();
  if (chromium === null) {
    // 本机缺 playwright-core 或 Edge：显式失败，不静默通过。
    throw new Error('本机没有可用的 Edge / playwright-core，无法做渲染对账');
  }
  const browser = await chromium.launch({ executablePath: EDGE_PATH });

  let failures = 0;
  try {
    // 逐个页面跑：`PARITY_PAGES` 新增一行就自动多覆盖一个列表页。
    for (const target of PARITY_PAGES) {
      const issues = await checkPage(browser, target);
      if (issues !== 0) failures += 1;
    }
  } finally {
    await browser.close();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

/** 对账一个页面；返回问题条数。 */
async function checkPage(browser: PwBrowser, target: ParityPage): Promise<number> {
  const apiRes = await fetch(`${BASE}${target.apiPath}`);
  if (!apiRes.ok) throw new Error(`GET ${target.apiPath} → ${String(apiRes.status)}`);
  const body = (await apiRes.json()) as { items?: readonly unknown[] };
  const apiItems = body.items?.length ?? 0;

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const failedAssets: string[] = [];
  page.on('requestfailed', (r: unknown) => {
    const req = r as { url: () => string; failure: () => { errorText: string } | null };
    failedAssets.push(`${req.url()} :: ${req.failure()?.errorText ?? ''}`);
  });

  try {
    await page.goto(`${BASE}${target.route}`, { waitUntil: 'networkidle' });
    // 水合 + 首帧请求都在 networkidle 之后；再留一点余量给 React 提交。
    await page.waitForTimeout(1_500);

    const renderedRows = await page.$$eval('table tbody tr', (els) => els.length);
    const statusCount = await page.evaluate(() => {
      const el = document.querySelector('span[role="status"]');
      const m = /共\s*(\d+)\s*条记录/.exec(el?.textContent ?? '');
      return m === null ? 0 : Number(m[1]);
    });

    const issues = judgeRenderParity({ apiItems, renderedRows, statusCount });

    console.log(`[render] ${BASE}${target.route}`);
    console.log(
      `  apiItems=${String(apiItems)} renderedRows=${String(renderedRows)} statusCount=${String(statusCount)}`,
    );
    if (failedAssets.length > 0) {
      console.log(`  失败请求 ${String(failedAssets.length)} 个：`);
      for (const f of failedAssets.slice(0, 10)) console.log(`    · ${f}`);
    }
    if (issues.length === 0) {
      console.log('  ✓ 接口条数与渲染行数一致');
      return 0;
    }
    for (const issue of issues) console.log(`  ✗ ${issue.code} — ${issue.message}`);
    const shot = resolve(
      ROOT,
      'docs',
      'Spec',
      'screenshots',
      `b02-render-mismatch${target.route.replaceAll('/', '-')}.png`,
    );
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`  截图：${shot}`);
    return issues.length;
  } finally {
    await page.close();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('scripts/check-datasets-render.ts') ||
    process.argv[1].endsWith('scripts\\check-datasets-render.ts'));

if (isMain) {
  void main().catch((err: unknown) => {
    console.error('[render] 异常：', err);
    process.exitCode = 1;
  });
}
