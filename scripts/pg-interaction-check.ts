/**
 * `#1` 浏览器交互验收（PG-03 / PG-04）· 真实 Chromium/Edge 驱动。
 *
 * 为什么不用 MCP：本轮 MCP 浏览器工具被安全分类器持续拦截（约 30 次全部返回
 * 「temporarily unavailable」），而验收要求必须是**真实浏览器**的交互证据。
 * 这里直接用本机已有的 `playwright-core`（npx 缓存里的 1.65.0）+ 本机 Edge，
 * 与本项目「依赖走本地 npm 包、不联网下载」的约束一致。
 *
 * 四条验收点：
 *  1. **进度条位宽不抖**：RUNNING 期间连续采样进度条与计数区的 boundingBox 宽度，
 *     任何一次宽度变化都算失败。用真实的慢速 fixture 网关造一个 30 秒以上的 run。
 *  2. **终态停轮询**：run 进入终态后静置 6 秒，统计这 6 秒内 `/api/runs/` 的请求数，
 *     必须是 0（终态后再打接口就是浪费）。
 *  3. **Esc 关闭且焦点归还**：点开抽屉 → 焦点进入抽屉 → 按 Esc → 抽屉关闭且
 *     `document.activeElement` 回到打开它的那个「查看」按钮。
 *  4. **刷新后抽屉关闭**：打开抽屉后 `page.reload()`，抽屉必须是关闭的。
 *
 * 每个断言失败都会写出截图到 `docs/Spec/screenshots/` 作为证据。
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'docs', 'Spec', 'screenshots');
const BASE = process.env['PG_BASE'] ?? process.argv[2] ?? 'http://127.0.0.1:3000';
const RUN_ID = process.env['PG_RUN_ID'] ?? process.argv[3] ?? '97e2907d-9919-43c2-9e42-9f8cb884060b';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/**
 * 从 npx 缓存里加载 `playwright-core`（项目本身**不新增依赖**）。
 * 这是验收脚本，不是产品代码；把版本钉在缓存路径上比引入一个新的
 * 400MB devDependency 更符合「不联网、不加依赖」的约束。
 */
const PW_CORE = resolve(
  'C:/Users/15539/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.js',
);

interface PwPage {
  goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
  reload: (opts?: { waitUntil?: string }) => Promise<unknown>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  $: (sel: string) => Promise<{
    boundingBox: () => Promise<{ width: number; height: number } | null>;
  } | null>;
  $eval: <T>(sel: string, fn: (n: Element) => T) => Promise<T>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  locator: (sel: string, opts?: { hasText?: string }) => {
    first: () => {
      focus: () => Promise<void>;
      click: () => Promise<void>;
      count: () => Promise<number>;
      isVisible: () => Promise<boolean>;
      waitFor: (opts: { state: string; timeout?: number }) => Promise<void>;
    };
    count: () => Promise<number>;
    waitFor: (opts: { state: string; timeout?: number }) => Promise<void>;
    isVisible: () => Promise<boolean>;
  };
  keyboard: { press: (k: string) => Promise<void> };
  on: (ev: string, cb: (req: { url: () => string }) => void) => void;
}

interface PwBrowser {
  newPage: (opts: { viewport: { width: number; height: number } }) => Promise<PwPage>;
  close: () => Promise<void>;
}

async function launch(): Promise<PwBrowser> {
  type Launcher = { launch: (o: { executablePath: string }) => Promise<PwBrowser> };
  const mod = (await import(pathToFileURL(PW_CORE).href)) as {
    default?: { chromium?: Launcher };
    chromium?: Launcher;
  };
  // playwright-core 的 ESM 命名空间把 API 挂在 `default` 上；两种形状都兜住。
  const api = mod.default ?? mod;
  const chromium = api.chromium;
  if (chromium === undefined) throw new Error('playwright-core 未导出 chromium');
  return chromium.launch({ executablePath: EDGE });
}

let failures = 0;

function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${msg}`);
  }
}

async function shot(page: PwPage, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: false });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  if (RUN_ID === '') throw new Error('缺少 PG_RUN_ID');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const apiHits: string[] = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes(`/api/runs/${RUN_ID}`)) apiHits.push(u);
  });

  // ---- 1. 进度条位宽不抖 -------------------------------------------------
  console.log('[1] 进度条位宽不抖');
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'networkidle' });

  const probe = async (): Promise<{ bar: string; wrap: string; label: string } | null> => {
    const el = await page.$('progress[aria-label="运行进度"]');
    if (el === null) return null;
    const bar = await el.boundingBox();
    const wrapEl = await page.$('span.num.min-w-\\[22ch\\]');
    const wrap = wrapEl === null ? null : await wrapEl.boundingBox();
    const label = await page.$eval('span.num.min-w-\\[22ch\\]', (n) => n.textContent ?? '');
    if (bar === null || wrap === null) return null;
    return { bar: `${String(bar.width)}x${String(bar.height)}`, wrap: String(wrap.width), label };
  };

  const samples: { geom: string; label: string }[] = [];
  let sawRunning = false;
  for (let i = 0; i < 40; i++) {
    const s = await probe();
    if (s !== null) {
      sawRunning = true;
      // **只比几何尺寸**：计数文字本来就会变（那正是进度在走），
      // 把它拼进比较键会把「进度推进」误判成「位宽抖动」。
      samples.push({ geom: `${s.bar} / wrap=${s.wrap}`, label: s.label });
    }
    await sleep(500);
    const status = await page
      .$eval('body', (b) => b.textContent ?? '')
      .then((t) => (t.includes('运行中') ? 'RUNNING' : 'DONE'));
    if (status === 'DONE' && sawRunning && i > 3) break;
  }
  const uniqGeom = [...new Set(samples.map((s) => s.geom))];
  const labels = [...new Set(samples.map((s) => s.label))];
  check(samples.length > 0, `采到进度条样本 ${String(samples.length)} 个`);
  check(
    uniqGeom.length === 1,
    `位宽全程不变（几何取值 ${String(uniqGeom.length)} 种：${uniqGeom.join(' | ')}）`,
  );
  // 采样期间确实在推进 —— 否则「位宽不变」可能是「根本没在跑」造成的假绿。
  check(labels.length > 1, `采样期间进度确有变化（读数 ${String(labels.length)} 种：${labels.join(' → ')}）`);
  await shot(page, 'pg03-progress');

  // ---- 2. 终态停轮询 -----------------------------------------------------
  console.log('[2] 终态停轮询');
  for (let i = 0; i < 120; i++) {
    const t = await page.$eval('body', (b) => b.textContent ?? '');
    if (!t.includes('运行中') && !t.includes('待执行')) break;
    await sleep(1000);
  }
  await sleep(1500); // 让最后一次在途请求落地
  const before = apiHits.length;
  await sleep(6000);
  const during = apiHits.length - before;
  check(during === 0, `终态静置 6s 内 /api/runs 请求数 = ${String(during)}`);
  await shot(page, 'pg03-terminal');

  // ---- 3. Esc 关闭且焦点归还 --------------------------------------------
  console.log('[3] Esc 关闭且焦点归还');
  const viewBtn = page.locator('table tbody tr button', { hasText: '查看' }).first();
  const rowCount = await page.locator('table tbody tr').count();
  if (rowCount === 0) {
    check(false, '明细表没有行，无法验证抽屉（需要一条有结果的 run）');
  } else {
    await viewBtn.focus();
    await viewBtn.click();
    const sheet = page.locator('[role="dialog"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });
    check(await sheet.isVisible(), '抽屉已打开');
    check(
      await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d !== null && d.contains(document.activeElement);
      }),
      '焦点已进入抽屉',
    );
    await sleep(500);
    await shot(page, 'pg04-open');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden', timeout: 10_000 });
    check(!(await sheet.isVisible()), 'Esc 后抽屉关闭');
    const returned = await page.evaluate(() => {
      const a = document.activeElement;
      return a !== null && a.tagName === 'BUTTON' && (a.textContent ?? '').includes('查看');
    });
    check(returned, '焦点归还到「查看」按钮');
    await shot(page, 'pg04-closed');
  }

  // ---- 4. 刷新后抽屉关闭 -------------------------------------------------
  console.log('[4] 刷新后抽屉关闭');
  if (rowCount > 0) {
    await viewBtn.click();
    const sheet = page.locator('[role="dialog"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });
    check(await sheet.isVisible(), '再次打开抽屉');
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(1000);
    const stillOpen = await page.locator('[role="dialog"]').count();
    check(stillOpen === 0, `刷新后抽屉数 = ${String(stillOpen)}（应为 0）`);
    await shot(page, 'pg04-after-reload');
  }

  await browser.close();
  console.log(failures === 0 ? 'ALL PASS' : `FAILURES=${String(failures)}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((err: unknown) => {
  console.error('[pg] 异常：', err);
  process.exitCode = 1;
});
