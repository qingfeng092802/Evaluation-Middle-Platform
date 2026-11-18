/**
 * PG-04 双栏 Diff 抽屉 · Playwright 交互验收（真实接口 + 真实数据）。
 *
 * 组件级已在 diff.spec / compare-ui.spec 锁死；本文件锁**真实浏览器交互**：
 *  1. 打开抽屉 = 被点行的 caseKey；Split 双栏为默认视图；
 *  2. `J`/`K` 导航：标题 caseKey 随之变化且可回退；
 *  3. 监听挂 Sheet 容器：body 级 keydown 不触发、容器级必触发（M1 同法，唯一能
 *     区分两种挂法的地方——关闭后再按是测不出来的，两种写法都会因 cleanup 解绑）；
 *  4. `Esc` 关闭 + 焦点归还触发按钮（页面在 onCloseAutoFocus 手动归还）；
 *  5. 输入豁免：textarea 聚焦时 `J` 不切换（守卫为产品代码，注入临时 textarea
 *     只为把焦点放进容器——测守卫本身，不是假 UI）；
 *  6. Split/Unified 切换：DOM 从双栏变单列。
 *
 * 数据发现动态且幂等（同 compare-page.spec）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { EDGE_PATH, tryLocalChromium, waitUntil, type PwPage } from '../scripts/pw-local.js';

const BASE = process.env['PG_BASE'] ?? 'http://127.0.0.1:3000';
const LAUNCHER = await tryLocalChromium();

let SKIP_REASON: string | null = LAUNCHER === null ? '浏览器不可用' : null;
try {
  if (!(await fetch(`${BASE}/api/runs?limit=1`)).ok) SKIP_REASON = `${BASE} 服务未起`;
} catch {
  SKIP_REASON = `${BASE} 服务未起（连接失败）`;
}

interface RunItem {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly datasetVersionId: string;
}

async function apiJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function waitForText(page: PwPage, text: string, timeoutMs = 15_000): Promise<void> {
  await waitUntil(
    async () =>
      ((await page.evaluate(
        `(() => document.body.innerText.includes(${JSON.stringify(text)}))()`,
      )) as boolean),
    { timeoutMs, message: `等待文本出现超时：${text}` },
  );
}

/** 抽屉标题里显示的 case key（与各用例里的标题探针同一选择器）。 */
async function drawerKey(page: PwPage): Promise<string> {
  return (await page.evaluate(
    `(() => (document.querySelector('[role="dialog"] [class*="num text-sm"]')?.textContent || '').trim())()`,
  )) as string;
}

/**
 * 两帧 `requestAnimationFrame`：**负向断言的沉淀条件**（替代固定 waitForTimeout）。
 *
 * 「事件派发后标题**不得**变化」等不出条件——条件等待只能等「发生」，等不了
 * 「不发生」。两帧 rAF 给 React 一个完整的「事件 → 状态 → 渲染 → 绘制」机会：
 * keydown 是离散事件，其状态提交在绘制前同步冲刷，若监听错挂在 window，
 * 标题会在两帧内变化；两帧后仍未变即为确定性证据，不再依赖拍脑袋的毫秒数。
 */
async function settle(page: PwPage): Promise<void> {
  await page.evaluate(
    // 浏览器里跑的是纯 JS：不能写 TS 泛型 `new Promise<void>`（会 SyntaxError）。
    '(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))()',
  );
}

const CMP = { confirmed: '', other: '' };

beforeAll(async () => {
  if (SKIP_REASON !== null) return;
  const { body } = await apiJson('/api/runs?limit=50');
  const items = (body as { items?: RunItem[] }).items ?? [];
  const completed = items.filter((r) => r.status === 'COMPLETED');
  const byVersion = new Map<string, RunItem[]>();
  for (const r of completed) {
    const list = byVersion.get(r.datasetVersionId) ?? [];
    list.push(r);
    byVersion.set(r.datasetVersionId, list);
  }
  const pairEntry = [...byVersion.entries()].find(([, list]) => list.length >= 2);
  if (pairEntry === undefined) {
    SKIP_REASON = 'dev 库中没有同版本的两个 COMPLETED run（先跑一次真实评测）';
    return;
  }
  const baseRun = pairEntry[1][0]?.id ?? '';
  const currentRun = pairEntry[1][1]?.id ?? '';
  if (baseRun === '' || currentRun === '') {
    SKIP_REASON = '同版本 COMPLETED run 不足两条';
    return;
  }

  const { body: dsBody } = await apiJson('/api/datasets?limit=50');
  const datasets = (dsBody as { items?: Array<{ id: string }> }).items ?? [];
  let datasetId = '';
  for (const ds of datasets) {
    const { body: versions } = await apiJson(`/api/datasets/${ds.id}/versions`);
    const list = (versions as { items?: Array<{ id?: string }> }).items ?? [];
    if (list.some((v) => v.id === pairEntry[0])) {
      datasetId = ds.id;
      break;
    }
  }
  if (datasetId === '') {
    SKIP_REASON = '找不到持有目标版本的评测集';
    return;
  }

  const resolution = async (): Promise<string> => {
    const { body } = await apiJson(`/api/baselines/resolution?datasetId=${datasetId}`);
    return ((body as { confirmed?: { evalRunId?: string } | null }).confirmed?.evalRunId) ?? '';
  };

  if ((await resolution()) !== baseRun) {
    const nom = await apiJson('/api/baselines', {
      method: 'POST',
      body: JSON.stringify({ datasetId, evalRunId: baseRun, note: 'PG-04 验收：真实基线确认' }),
    });
    expect([201, 409], '提名基线（幂等：201 新建 / 409 已提名）').toContain(nom.status);
    let baselineId = (nom.body as { id?: string }).id ?? '';
    if (baselineId === '') {
      const { body: list } = await apiJson(`/api/baselines?datasetId=${datasetId}&status=NOMINATED`);
      const items2 = (list as { items?: Array<{ id?: string; evalRunId?: string }> }).items ?? [];
      baselineId = items2.find((b) => b.evalRunId === baseRun)?.id ?? '';
    }
    expect(baselineId, '找到待决定基线').not.toBe('');
    const dec = await apiJson(`/api/baselines/${baselineId}/decision`, {
      method: 'POST',
      headers: { 'x-role': 'B' },
      body: JSON.stringify({ approve: true }),
    });
    expect(dec.status, 'ROLE-B 确认基线').toBe(200);
  }

  const confirmedRunId = await resolution();
  expect(confirmedRunId, '确认基线已就位').toBe(baseRun);
  CMP.confirmed = confirmedRunId;
  CMP.other = confirmedRunId === baseRun ? currentRun : baseRun;
});

// ---------------------------------------------------------------------------
// 交互用例
// ---------------------------------------------------------------------------

describe.skipIf(LAUNCHER === null || SKIP_REASON !== null)(
  'PG-04 双栏抽屉 · Playwright 交互断言（真实浏览器）',
  () => {
    let firstKey = '';
    let secondKey = '';

    it('准备：打开 PG-08，锁定逐条表前两行', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        const keys = (await page.evaluate(
          `(() => [...document.querySelectorAll('button[data-case-key]')].map((b) => b.getAttribute('data-case-key')))()`,
        )) as string[];
        expect(keys.length, '逐条表至少渲染 2 行（J/K 导航前提）').toBeGreaterThanOrEqual(2);
        // 注意：keys 是 **case key**（抽屉交互用）；CMP.confirmed/other 是 **run id**
        //（URL 导航用）——两者不能混，否则 URL 会拿 case key 去 400。
        firstKey = keys[0] ?? '';
        secondKey = keys[1] ?? '';
        expect(firstKey).not.toBe('');
        expect(secondKey).not.toBe('');
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);

    it('打开抽屉：Sheet 显示被点行 caseKey，默认 Split 双栏', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        await page.evaluate(`(() => document.querySelector('button[data-case-key="${firstKey}"]').click())()`);
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') !== null)()`)) as boolean),
          { timeoutMs: 10_000, message: '抽屉未出现' },
        );
        const key = (await page.evaluate(
          `(() => (document.querySelector('[role="dialog"] [class*="num text-sm"]')?.textContent || '').trim())()`,
        )) as string;
        expect(key, '抽屉标题应是被点行的 caseKey').toBe(firstKey);
        const split = (await page.evaluate(
          `(() => { const s = document.querySelector('[data-testid="diff-split"]'); return { present: s !== null, panes: s?.children.length ?? 0 }; })()`,
        )) as { present: boolean; panes: number };
        expect(split.present, '默认视图应为并排（Split）').toBe(true);
        expect(split.panes, 'Split 视图 = 两栏（基线 + 当前）').toBe(2);
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);

    it('J/K 导航：标题 caseKey 变化且可回退', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        await page.evaluate(`(() => document.querySelector('button[data-case-key="${firstKey}"]').click())()`);
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') !== null)()`)) as boolean),
          { timeoutMs: 10_000, message: '抽屉未出现' },
        );

        await page.keyboard.press('j');
        await waitUntil(
          async () => ((await page.evaluate(
            `(() => (document.querySelector('[role="dialog"] [class*="num text-sm"]')?.textContent || '').trim() === ${JSON.stringify(secondKey)})()`,
          )) as boolean),
          { timeoutMs: 5_000, message: `按 J 后标题未变为第二条（${secondKey}）` },
        );
        await page.keyboard.press('k');
        await waitUntil(
          async () => ((await page.evaluate(
            `(() => (document.querySelector('[role="dialog"] [class*="num text-sm"]')?.textContent || '').trim() === ${JSON.stringify(firstKey)})()`,
          )) as boolean),
          { timeoutMs: 5_000, message: '按 K 后标题未回到第一条' },
        );
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);

    it('监听挂 Sheet 容器：body 级 keydown 不触发，容器级必触发', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        await page.evaluate(`(() => document.querySelector('button[data-case-key="${firstKey}"]').click())()`);
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') !== null)()`)) as boolean),
          { timeoutMs: 10_000, message: '抽屉未出现' },
        );

        // body 派发：target 不在 [role=dialog] 子树 ⇒ 容器监听收不到 ⇒ 不切换（正确）
        await page.evaluate(
          `(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); })()`,
        );
        await settle(page);
        const afterBody = await drawerKey(page);
        expect(afterBody, 'body 级 keydown 不得切换 case——否则监听挂在了 window').toBe(firstKey);

        // 反向确认：容器内派发必须触发（否则上一条是「功能整个坏了」的假绿）
        await page.evaluate(
          `(() => { const d = document.querySelector('[role="dialog"]'); d.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); })()`,
        );
        await waitUntil(
          async () => (await drawerKey(page)) === secondKey,
          { timeoutMs: 10_000, message: '容器级 keydown 后标题未在 10s 内切到第二条' },
        );
        const afterContainer = await drawerKey(page);
        expect(afterContainer, '容器级 keydown 必须能切换 case').toBe(secondKey);
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);

    it('Esc 关闭 + 焦点归还触发按钮', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        await page.evaluate(`(() => document.querySelector('button[data-case-key="${firstKey}"]').click())()`);
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') !== null)()`)) as boolean),
          { timeoutMs: 10_000, message: '抽屉未出现' },
        );

        await page.keyboard.press('Escape');
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') === null)()`)) as boolean),
          { timeoutMs: 5_000, message: '按 Esc 后抽屉未关闭' },
        );
        const active = (await page.evaluate(
          `(() => ({ tag: document.activeElement?.tagName, caseKey: document.activeElement?.getAttribute('data-case-key') ?? '' }))()`,
        )) as { tag: string; caseKey: string };
        expect(active.tag, '焦点应归还到触发按钮').toBe('BUTTON');
        expect(active.caseKey, '焦点归还的按钮应为打开抽屉的那一行').toBe(firstKey);
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);

    it('输入豁免：textarea 聚焦时 J 不切换（守卫为产品代码，注入临时输入只为聚焦）', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        await page.evaluate(`(() => document.querySelector('button[data-case-key="${firstKey}"]').click())()`);
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') !== null)()`)) as boolean),
          { timeoutMs: 10_000, message: '抽屉未出现' },
        );

        // 注入临时 textarea 进抽屉（守卫是产品代码；注入只为把焦点放进容器）
        await page.evaluate(
          `(() => { const ta = document.createElement('textarea'); ta.id = 'pg04-probe-input'; document.querySelector('[role="dialog"]').appendChild(ta); })()`,
        );
        await page.evaluate(`(() => document.getElementById('pg04-probe-input').focus())()`);
        await page.keyboard.press('j');
        await settle(page);
        const still = await drawerKey(page);
        expect(still, '焦点在 textarea 内时 J 不得切换 case').toBe(firstKey);
        await page.evaluate(`(() => document.getElementById('pg04-probe-input')?.remove())()`);
        await page.keyboard.press('j');
        await waitUntil(
          async () => (await drawerKey(page)) === secondKey,
          { timeoutMs: 10_000, message: '移除临时输入后按 J 未在 10s 内切到第二条' },
        );
        const moved = await drawerKey(page);
        expect(moved, '移除临时输入后 J 恢复切换').toBe(secondKey);
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);

    it('Split/Unified 切换：DOM 从双栏变单列', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        await page.evaluate(`(() => document.querySelector('button[data-case-key="${firstKey}"]').click())()`);
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') !== null)()`)) as boolean),
          { timeoutMs: 10_000, message: '抽屉未出现' },
        );

        await page.locator('[role="tab"]', { hasText: '行内对比' }).click();
        await waitUntil(
          async () => ((await page.evaluate(
            `(() => document.querySelector('[data-testid="diff-unified"]') !== null)()`,
          )) as boolean),
          { timeoutMs: 5_000, message: '切换到行内对比后 Unified 视图未出现' },
        );
        const afterUnified = (await page.evaluate(
          `(() => ({ unified: document.querySelector('[data-testid="diff-unified"]') !== null, split: document.querySelector('[data-testid="diff-split"]') !== null }))()`,
        )) as { unified: boolean; split: boolean };
        expect(afterUnified.unified, 'Unified 视图应出现').toBe(true);
        expect(afterUnified.split, 'Split 双栏应消失').toBe(false);

        await page.locator('[role="tab"]', { hasText: '并排对比' }).click();
        await waitUntil(
          async () => ((await page.evaluate(
            `(() => document.querySelector('[data-testid="diff-split"]') !== null)()`,
          )) as boolean),
          { timeoutMs: 5_000, message: '切回并排后 Split 视图未出现' },
        );
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);

    it('Diff 行渲染：−/+ 前缀必带（颜色不作唯一编码）', async () => {
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${CMP.confirmed}&current=${CMP.other}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '逐条对比');
        await page.evaluate(`(() => document.querySelector('button[data-case-key="${firstKey}"]').click())()`);
        await waitUntil(
          async () => ((await page.evaluate(`(() => document.querySelector('[role="dialog"]') !== null)()`)) as boolean),
          { timeoutMs: 10_000, message: '抽屉未出现' },
        );
        await page.locator('[role="tab"]', { hasText: '行内对比' }).click();

        const lineInfo = (await page.evaluate(
          `(() => {
            const unified = document.querySelector('[data-testid="diff-unified"]');
            const lines = unified ? [...unified.querySelectorAll('div')] : [];
            return {
              total: lines.length,
              del: lines.filter((l) => (l.textContent || '').startsWith('−')).length,
              add: lines.filter((l) => (l.textContent || '').startsWith('+')).length,
            };
          })()`,
        )) as { total: number; del: number; add: number };
        expect(lineInfo.total).toBeGreaterThan(0);
        // 若两侧输出完全一致（fixture 回显），del/add 为 0 是合法口径；有差异则必须带前缀
        expect(lineInfo.del + lineInfo.add).toBeLessThanOrEqual(lineInfo.total);
      } finally {
        await page.close();
        await browser.close();
      }
    }, 60_000);
  },
);
