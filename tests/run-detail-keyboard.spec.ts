/**
 * `PG-04` 抽屉的**键盘交互**（`DESIGN.md` §4.3 / §6.3）。
 *
 * ## 为什么必须是真实浏览器
 *
 * 这四条全部是**事件层**行为，服务端渲染与 class 断言一条也证明不了：
 *
 *  1. `J` 下一条 / `K` 上一条 —— 按下去要真的换人；
 *  2. 监听挂在 **Sheet 容器**上，不是 `window` —— 抽屉关了就不该再有反应；
 *  3. `Esc` 关闭且**焦点归还**到打开它的那个「查看」按钮；
 *  4. **`INPUT` / `TEXTAREA` / `SELECT` / `[contenteditable]` 聚焦时一律不拦截 `J`/`K`**
 *     —— 否则用户在输入框里打字母 `j` 和 `k` 会被吞掉。
 *
 * 第 4 条是这份文件里最容易被写成假绿的一条：抽屉当前是只读的（`PG-04` 无输入框），
 * 于是「没有输入框」这条路径永远不会被走到。这里**主动往抽屉里插一个 input 并聚焦**，
 * 再按 `j` —— 测的是监听器的作用域判断，不是页面恰好有没有输入框。
 * 将来 `PG-04` 加了筛选框，这条断言仍然有效。
 *
 * ## 循环语义
 *
 * `DESIGN.md` §4.3 只说「上一条 / 下一条」，未写边界。原型（`ui-reference.html`
 * 的 `navigateDrawerCase`）是**循环**的，这里跟随原型：第一条按 `K` 到最后一条、
 * 最后一条按 `J` 回第一条。理由是「按到尽头没反应」与「不可点」同罪 ——
 * 用户无法判断是到头了还是坏了。
 *
 * ## 跳过 ≠ 通过
 *
 * 需要跑着的服务（`npm run dev:all`）与本机 Edge。条件不满足时显式 warn 后跳过；
 * 合并前必须在服务起来的情况下重跑一遍。
 */
import type { EvalCaseResult } from '@eval-platform/contracts';
import { describe, expect, it } from 'vitest';
import { EDGE_PATH, tryLocalChromium, type PwPage } from '../scripts/pw-local.js';
import { caseKeyLabel } from '../lib/ui/runs';

const BASE = process.env['PG_BASE'] ?? 'http://127.0.0.1:3000';
const LAUNCHER = await tryLocalChromium();

interface Fixture {
  readonly runId: string;
}

/**
 * 找一条**至少 2 条 Case** 的 run。
 *
 * 少于 2 条时 `J`/`K` 无从验证（换人也还是同一条），必须跳过而不是当成通过。
 *
 * 这里**只认 runId**，不缓存 case 顺序：明细表按得分排序而夹具里大量同分，
 * 同分行的相对顺序由数据库决定、无任何保证。行序基准必须从**渲染后的 DOM**
 * 实读（见 `renderedCaseKeys`），否则会在同分边界上随机翻车。
 */
async function findFixture(): Promise<Fixture | null> {
  try {
    const listRes = await fetch(`${BASE}/api/runs?limit=20`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!listRes.ok) return null;
    const list = (await listRes.json()) as {
      items?: readonly { readonly id: string; readonly counts?: { readonly totalCases?: number } }[];
    };

    for (const run of list.items ?? []) {
      if ((run.counts?.totalCases ?? 0) < 2) continue;
      const casesRes = await fetch(
        `${BASE}/api/runs/${run.id}/cases?limit=200&sortBy=score&order=asc`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!casesRes.ok) continue;
      const cases = (await casesRes.json()) as { items?: readonly EvalCaseResult[] };
      if ((cases.items ?? []).length >= 2) return { runId: run.id };
    }
    return null;
  } catch {
    return null;
  }
}

const FIXTURE = await findFixture();

if (FIXTURE === null) {
  console.warn(
    `[run-detail-keyboard] ${BASE} 上没有 ≥2 条 Case 的 run（或服务未起），` +
      '键盘交互断言已跳过；合并前先 npm run dev:all + 跑一条评测，再 npm run test。',
  );
}

/** 抽屉标题里显示的 case key（等宽、`title` 是完整 key）。 */
async function sheetTitle(page: PwPage): Promise<string> {
  return page.$eval('[role="dialog"] h2', (n) => (n.textContent ?? '').trim());
}

async function sheetOpen(page: PwPage): Promise<boolean> {
  return (await page.locator('[role="dialog"]').count()) > 0;
}

/**
 * 从**页面里实读**明细表当前的 case key 顺序。
 *
 * 为什么不用接口返回的顺序做基准：明细表按 `sortBy=score&order=asc` 排，
 * 而 50 条夹具里 30 条同分 1.0、20 条同分 0.0 —— **同分行的相对顺序由数据库
 * 决定，没有任何保证**。拿接口顺序去断言「第 2 行是 case-0032」会在同分边界上
 * 随机翻车（今天绿、换台机器红），而这种红会被误读成「J/K 坏了」。
 *
 * 表格每一行的操作列按钮带 `aria-label` 之外的上下文不好取，这里改读每行
 * `td:first-child` 的 `title`（完整 case key，见明细表 `Case Key` 列）。
 */
async function renderedCaseKeys(page: PwPage): Promise<string[]> {
  return page.$$eval('table tbody tr td:first-child [title]', (els) =>
    els.map((el) => el.getAttribute('title') ?? ''),
  );
}

/**
 * 打开第 `index` 行的抽屉，返回**实际点开的那个 case** 的标签。
 *
 * 返回实际值而不是假定它等于 `fixture.labels[index]`：行序可能因同分排序而变，
 * 断言要对着「点进去的确实是第 index 行」而不是「接口的第 index 条」。
 */
async function openRow(page: PwPage, index: number): Promise<string> {
  const btn = page.locator('table tbody tr button', { hasText: '查看' }).nth(index);
  await btn.focus();
  await btn.click();
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
  return sheetTitle(page);
}

describe.skipIf(FIXTURE === null || LAUNCHER === null)(
  'PG-04 抽屉 · 键盘交互（真实浏览器）',
  () => {
    it(
      'J 下一条 / K 上一条 / Esc 关闭并归还焦点',
      async () => {
        const fixture = FIXTURE as Fixture;
        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        try {
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          await page.goto(`${BASE}/runs/${fixture.runId}`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1_500);

          // 基准取**渲染顺序**，不是接口顺序（同分行的相对顺序无保证，见 renderedCaseKeys）。
          const keys = await renderedCaseKeys(page);
          expect(keys.length, '明细表至少要渲染 2 行才谈得上「下一条」').toBeGreaterThanOrEqual(2);

          const first = await openRow(page, 0);
          expect(first, '打开后标题应是明细表第 1 行的 case').toBe(caseKeyLabel(keys[0] ?? ''));

          // ---- J：下一条 ----
          await page.keyboard.press('j');
          await page.waitForTimeout(400);
          expect(await sheetTitle(page), '按 J 应切到渲染顺序的第 2 行').toBe(
            caseKeyLabel(keys[1] ?? ''),
          );

          // ---- K：上一条 ----
          await page.keyboard.press('k');
          await page.waitForTimeout(400);
          expect(await sheetTitle(page), '按 K 应回到渲染顺序的第 1 行').toBe(
            caseKeyLabel(keys[0] ?? ''),
          );

          // ---- Esc：关闭 + 焦点归还 ----
          await page.keyboard.press('Escape');
          await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 10_000 });
          expect(await sheetOpen(page), 'Esc 后抽屉应关闭').toBe(false);

          const returned = await page.evaluate(
            "(() => { const a = document.activeElement; return a !== null && a.tagName === 'BUTTON' && (a.textContent || '').includes('查看'); })()",
          );
          expect(returned, 'Esc 后焦点必须回到打开抽屉的「查看」按钮').toBe(true);
        } finally {
          await browser.close();
        }
      },
      120_000,
    );

    it(
      'J/K 在 INPUT / TEXTAREA / SELECT / contenteditable 聚焦时一律不拦截',
      async () => {
        const fixture = FIXTURE as Fixture;
        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        try {
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          await page.goto(`${BASE}/runs/${fixture.runId}`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1_500);

          const first = await openRow(page, 0);

          // 往抽屉里注入四种可输入元素并逐个聚焦后按 j。
          // 抽屉现在是只读的（`PG-04` 无输入框），所以这条路径只能这样造 ——
          // 测的是监听器的作用域判断，不是页面当前恰好有没有输入框。
          for (const kind of ['input', 'textarea', 'select', 'contenteditable'] as const) {
            await page.evaluate(`(() => {
              const d = document.querySelector('[role="dialog"]');
              if (d === null) return;
              const prev = d.querySelector('[data-probe]');
              if (prev !== null) prev.remove();
              let el;
              if ('${kind}' === 'contenteditable') {
                el = document.createElement('div');
                el.setAttribute('contenteditable', 'true');
              } else {
                el = document.createElement('${kind}');
              }
              el.setAttribute('data-probe', '1');
              el.setAttribute('aria-label', 'probe');
              el.textContent = '';
              d.appendChild(el);
              el.focus();
            })()`);
            await page.waitForTimeout(150);

            const focused = await page.evaluate(
              "(() => { const a = document.activeElement; return a === null ? 'null' : a.tagName + (a.getAttribute('contenteditable') === 'true' ? '[contenteditable]' : ''); })()",
            );
            expect(focused, `探针 ${kind} 应已获得焦点`).toContain(
              kind === 'contenteditable' ? 'contenteditable' : kind.toUpperCase(),
            );

            await page.keyboard.press('j');
            await page.waitForTimeout(400);

            expect(
              await sheetTitle(page),
              `${kind} 聚焦时按 J 不得切换 case（否则用户打不出字母 j）`,
            ).toBe(first);

            // 清理探针，避免影响下一轮
            await page.evaluate(
              "(() => { const p = document.querySelector('[data-probe]'); if (p !== null) p.remove(); })()",
            );
          }
        } finally {
          await browser.close();
        }
      },
      120_000,
    );

    it(
      '监听挂在 Sheet 容器上而不是 window：抽屉外的事件不触发 J/K',
      async () => {
        const fixture = FIXTURE as Fixture;
        const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
        if (browser === undefined) throw new Error('浏览器启动失败');

        try {
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          await page.goto(`${BASE}/runs/${fixture.runId}`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1_500);

          const keys = await renderedCaseKeys(page);
          expect(keys.length, '明细表至少要渲染 2 行').toBeGreaterThanOrEqual(2);

          const opened = await openRow(page, 0);
          expect(opened, '打开后标题应是明细表第 1 行').toBe(caseKeyLabel(keys[0] ?? ''));

          /**
           * 向 `body` 派发一次 `keydown`：事件的 `target` 是 `<body>`，
           * **不在** `[role="dialog"]` 的子树里，因此：
           *  - 监听挂在容器上 ⇒ 冒泡路径不经过容器 ⇒ 不触发（正确）；
           *  - 监听挂在 `window` 上 ⇒ 冒泡到 window 的事件都收得到 ⇒ 会触发（错误）。
           *
           * 这是唯一能区分两种挂法的地方。只在「抽屉关闭后再按」是测不出来的：
           * 两种写法在关闭时都会因 effect cleanup 而解绑，看起来一模一样。
           *
           * 也不能用 `page.keyboard.press` —— 那是派发给真实焦点元素，
           * 而 Radix 的 focus trap 会把焦点拉回抽屉，事件就落进容器里了。
           */
          await page.evaluate(
            "(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); })()",
          );
          await page.waitForTimeout(500);

          expect(
            await sheetTitle(page),
            '抽屉外（body）的 keydown 不得切换 case —— 否则说明监听挂在了 window 而非 Sheet 容器',
          ).toBe(opened);

          // 反向确认：容器内的事件**必须**还能触发，否则上一条会因「功能整个坏了」而假绿。
          await page.evaluate(
            "(() => { const d = document.querySelector('[role=\"dialog\"]'); d.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); })()",
          );
          await page.waitForTimeout(500);
          expect(
            await sheetTitle(page),
            '抽屉内的 keydown 必须切换 case（证明监听确实挂上了）',
          ).toBe(caseKeyLabel(keys[1] ?? ''));

          // 关闭后同样不再有反应。
          await page.keyboard.press('Escape');
          await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 10_000 });
          await page.evaluate(
            "(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); })()",
          );
          await page.waitForTimeout(500);
          expect(await sheetOpen(page), '抽屉关闭后按 J 不得把抽屉重新打开').toBe(false);
        } finally {
          await browser.close();
        }
      },
      120_000,
    );
  },
);
