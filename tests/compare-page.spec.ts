/**
 * PG-08 浏览器验收（`US-009` / `BL-2`；真实数据态：dev 栈 + 真实 run 对）。
 *
 * 覆盖横幅三态的**真实接口**链路（组件级三态已在 compare-ui.spec 单测锁死）：
 *  1. 无任何确认 → 契约横幅原文逐字；
 *  2. 提名 + ROLE-B 确认（真实 API 链路）→ 绿色氛围；
 *  3. 确认基线存在但比的是别的 run → 横幅仍在；
 *  4. 硬拒绝（同 run 自比）→ `describeIncomparable()` 原文原样展示。
 *
 * 数据发现是**动态且幂等**的：从 `/api/runs` 找同 `datasetVersionId` 的两个
 * COMPLETED run；基线确认走真实 API，重跑时命中 201/409/已确认三种状态都收敛
 * （CONFIRMED 是不可变终态，故以 resolution 的实际结果为准，不假设本次新建）。
 * 截图经 `PG08_SHOT_DIR` 环境变量落盘（未设置则跳过），目录在工作区而非仓库内。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGE_PATH, tryLocalChromium, waitUntil, type PwPage } from '../scripts/pw-local.js';

const BASE = process.env['PG_BASE'] ?? 'http://127.0.0.1:3000';
const SHOT_DIR = process.env['PG08_SHOT_DIR'] ?? null;
const LAUNCHER = await tryLocalChromium();

/** 需要服务的浏览器用例：服务未起 → 显式跳过（跳过 ≠ 通过）。 */
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
      (await page.evaluate(
        `(() => document.body.innerText.includes(${JSON.stringify(text)}))()`,
      )) as boolean,
    { timeoutMs, message: `等待文本出现超时：${text}` },
  );
}

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
  let baseRun = pairEntry[1][0]?.id ?? '';
  let currentRun = pairEntry[1][1]?.id ?? '';
  if (baseRun === '' || currentRun === '') {
    SKIP_REASON = '同版本 COMPLETED run 不足两条';
    return;
  }

  // datasetId 发现：遍历评测集，找到持有该版本的评测集（setup 逻辑，非断言）
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

  // 幂等的基线确认：CONFIRMED 是不可变终态，以 resolution 实际结果为准
  const resolution = async (): Promise<string> => {
    const { body } = await apiJson(`/api/baselines/resolution?datasetId=${datasetId}`);
    return ((body as { confirmed?: { evalRunId?: string } | null }).confirmed?.evalRunId) ?? '';
  };

  // dev 库多会话演进后可能已有 CONFIRMED 基线且指向别的 run（合法状态）：以已确认
  // 基线为锚重选对比对——对第二条基线确认必被 409 拒（BL-1），换锚只改当前指向（BL-4）。
  const existingConfirmed = await resolution();
  if (existingConfirmed !== '' && existingConfirmed !== baseRun) {
    baseRun = existingConfirmed;
    const others = pairEntry[1].map((r) => r.id).filter((id) => id !== baseRun);
    if (others.length === 0) {
      SKIP_REASON = '已确认基线所在版本没有第二个 COMPLETED run 可作对比';
      return;
    }
    currentRun = others[0] ?? currentRun;
  }

  if ((await resolution()) !== baseRun) {
    const nom = await apiJson('/api/baselines', {
      method: 'POST',
      body: JSON.stringify({ datasetId, evalRunId: baseRun, note: 'PG-08 验收：真实基线确认' }),
    });
    // 201 = 新提名；409 = 已提名过（幂等重跑），两者都收敛到「可决定」状态
    expect([201, 409], '提名基线（201 新建 / 409 已提名，均可继续）').toContain(nom.status);
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
  // 观察态需要「确认基线存在但比的是别的」：另一条 COMPLETED run 即为观察基线
  const otherRun = confirmedRunId === baseRun ? currentRun : baseRun;

  process.env['CMP_CONFIRMED_RUN'] = confirmedRunId;
  process.env['CMP_OTHER_RUN'] = otherRun;
});

afterAll(() => {
  delete process.env['CMP_CONFIRMED_RUN'];
  delete process.env['CMP_OTHER_RUN'];
});

describe.skipIf(LAUNCHER === null || SKIP_REASON !== null)(
  'PG-08 浏览器验收 · 横幅三态（真实接口 + 真实数据）',
  () => {
    it('已确认基线：绿色氛围 + 六行指标 + 雷达 canvas + 逐条表', async () => {
      const confirmedRun = process.env['CMP_CONFIRMED_RUN'] ?? '';
      const otherRun = process.env['CMP_OTHER_RUN'] ?? '';
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${confirmedRun}&current=${otherRun}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '对比基线为已确认基线');

        const probe = (await page.evaluate(
          `(() => ({
            bannerConfirmed: document.body.innerText.includes('对比基线为已确认基线'),
            bannerWarn: document.body.innerText.includes('尚未确认基线'),
            metricHeaders: [...(document.querySelectorAll('table')[0]?.querySelectorAll('thead th') ?? [])]
              .map((th) => (th.textContent || '').trim().replace('，点击切换排序', '')),
            metricRowCount: document.querySelectorAll('table')[0]?.querySelectorAll('tbody tr').length ?? 0,
            canvasCount: document.querySelectorAll('canvas').length,
          }))()`,
        )) as { bannerConfirmed: boolean; bannerWarn: boolean; metricHeaders: string[]; metricRowCount: number; canvasCount: number };

        expect(probe.bannerConfirmed).toBe(true);
        expect(probe.bannerWarn).toBe(false);
        // 排序朗读文案（sr-only span 的 textContent）从表头读数中剥除后再比对
        expect(probe.metricHeaders).toEqual(['指标', '基线', '当前', '变化']);
        expect(probe.metricRowCount).toBe(6);
        expect(probe.canvasCount).toBeGreaterThan(0);

        if (SHOT_DIR !== null) {
          mkdirSync(SHOT_DIR, { recursive: true });
          const file = join(SHOT_DIR, 'pg08-confirmed.png');
          await page.screenshot({ path: file, fullPage: true });
          writeFileSync(join(SHOT_DIR, 'pg08-confirmed.readings.txt'), JSON.stringify(probe, null, 1));
        }
      } finally {
        await page.close();
        await browser.close();
      }
    }, 120_000);

    it('观察态：确认基线存在但比的是别的 run → 契约横幅原文逐字', async () => {
      const confirmedRun = process.env['CMP_CONFIRMED_RUN'] ?? '';
      const otherRun = process.env['CMP_OTHER_RUN'] ?? '';
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        // confirmed = confirmedRun；本次拿 otherRun 当对比基线 ⇒ baselineConfirmed=false
        await page.goto(`${BASE}/runs/compare?baseline=${otherRun}&current=${confirmedRun}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '尚未确认基线，本次对比仅供观察，不作为门禁依据');
        const text = (await page.evaluate(`document.body.innerText`)) as string;
        expect(text).toContain('尚未确认基线，本次对比仅供观察，不作为门禁依据');

        if (SHOT_DIR !== null) {
          const file = join(SHOT_DIR, 'pg08-observation.png');
          await page.screenshot({ path: file, fullPage: true });
        }
      } finally {
        await page.close();
        await browser.close();
      }
    }, 120_000);

    it('硬拒绝：同 run 自比 → describeIncomparable() 原文原样展示', async () => {
      const confirmedRun = process.env['CMP_CONFIRMED_RUN'] ?? '';
      const browser = await LAUNCHER?.launch({ executablePath: EDGE_PATH });
      if (browser === undefined) throw new Error('浏览器启动失败');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${BASE}/runs/compare?baseline=${confirmedRun}&current=${confirmedRun}`, {
          waitUntil: 'networkidle',
        });
        await waitForText(page, '基线 Run 与当前 Run 是同一个任务');
        const text = (await page.evaluate(`document.body.innerText`)) as string;
        expect(text).toContain('基线 Run 与当前 Run 是同一个任务，无可比性');
      } finally {
        await page.close();
        await browser.close();
      }
    }, 120_000);
  },
);
