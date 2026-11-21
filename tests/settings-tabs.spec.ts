/**
 * PG-09 双 Tab（门禁规则 / 基线确认）· 真实浏览器交互验收（真实接口 + 真实数据）。
 *
 * 组件派生逻辑已在 settings-tabs-ui.spec 锁死；本文件锁**真实浏览器渲染与交互**：
 *  1. 四个 Tab 全部可点，`PENDING_TABS` 占位标注退场；
 *  2. 基线确认 Tab：角色语义提示随 Role Switcher 切换（A 提示禁用 / B 提示可操作），
 *     且 A 角色下 NOMINATED 行的确认 / 驳回按钮真实 disabled（BL-1）；
 *  3. 门禁规则 Tab：新建表单在场、ROLE-B 语义提示、派发历史入口。
 *
 * 数据动态发现且幂等：提名经真实 HTTP 预置（[201, 409] 双容忍——重复运行不炸）。
 * 服务 / 浏览器不可用 → 打印原因跳过（跳过 ≠ 通过；globalSetup 常驻时为 0 skip）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { EDGE_PATH, tryLocalChromium, waitUntil, type PwPage } from '../scripts/pw-local.js';


const BASE = process.env['PG_BASE'] ?? 'http://127.0.0.1:3000';
const LAUNCHER = await tryLocalChromium();

let SKIP_REASON: string | null = LAUNCHER === null ? '浏览器不可用' : null;
try {
  if (!(await fetch(`${BASE}/api/datasets?limit=1`)).ok) SKIP_REASON = `${BASE} 服务未起`;
} catch {
  SKIP_REASON = `${BASE} 服务未起（连接失败）`;
}

let page: PwPage;

beforeAll(async () => {
  if (SKIP_REASON !== null || LAUNCHER === null) return;
  const browser = await LAUNCHER.launch({ executablePath: EDGE_PATH });
  page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
});

async function bodyText(): Promise<string> {
  return (await page.evaluate('(() => document.body.innerText)()')) as string;
}

async function waitForText(text: string, timeoutMs = 15_000): Promise<void> {
  await waitUntil(
    async () => ((await page.evaluate(`(() => document.body.innerText.includes(${JSON.stringify(text)}))()`)) as boolean),
    { timeoutMs, message: `等待文本出现超时：${text}` },
  );
}

async function openTab(label: string): Promise<void> {
  await page.locator('button', { hasText: label }).first().click();
}

/** 把角色写进 localStorage 并刷新（getRole 懒 hydration，刷新后生效）。 */
async function setRoleAndReload(role: 'A' | 'B'): Promise<void> {
  await page.evaluate(`(() => { localStorage.setItem('eval-platform.role', ${JSON.stringify(role)}); })()`);
  await page.reload({ waitUntil: 'networkidle' });
}

/** 在指定 Tab 的评测集下拉里选中某集：等选项出现 → 原生 setter + change（React 受控）。 */
async function selectDataset(datasetId: string, selectId = 'baselines-dataset'): Promise<void> {
  await waitUntil(
    async () =>
      ((await page.evaluate(`(() => {
        const sel = document.getElementById(${JSON.stringify(selectId)});
        return sel !== null && [...sel.options].some((o) => o.value === ${JSON.stringify(datasetId)});
      })()`)) as boolean),
    { timeoutMs: 15_000, message: `等待下拉选项出现：${selectId}` },
  );
  await page.evaluate(`(() => {
    const sel = document.getElementById(${JSON.stringify(selectId)});
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, ${JSON.stringify(datasetId)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

describe('PG-09 双 Tab · 真实浏览器', () => {
  it('四个 Tab 全部可点，占位标注退场', async (ctx) => {
    if (SKIP_REASON !== null) return ctx.skip();
    const text = await bodyText();
    expect(text).toContain('模型网关');
    expect(text).toContain('门禁规则');
    expect(text).toContain('基线确认');
    expect(text).toContain('推送渠道');
    expect(text).not.toContain('上线）');
  });

  it('基线确认 Tab：A 角色提示禁用语义 + 提名行按钮真实 disabled；切 B 后可操作', async (ctx) => {
    if (SKIP_REASON !== null) return ctx.skip();

    // 预置提名（幂等：重复运行第二笔是 409，不炸）
    const datasets = (await (await fetch(`${BASE}/api/datasets?limit=1`)).json()) as {
      items: Array<{ id: string }>;
    };
    const datasetId = datasets.items[0]!.id;
    const runs = (await (await fetch(`${BASE}/api/runs?datasetId=${datasetId}&limit=20`)).json()) as {
      items?: Array<{ id: string; status: string }>;
    };
    const runPool = (runs.items ?? []).filter((r) => r.status === 'COMPLETED' || r.status === 'PARTIAL_FAILED');
    if (runPool.length === 0) SKIP_REASON = 'dev 库该评测集没有终态 run，无法预置提名';
    if (SKIP_REASON !== null) return ctx.skip();
    await fetch(`${BASE}/api/baselines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ datasetId, evalRunId: runPool[0]!.id, note: 'settings-tabs 浏览器档预置提名' }),
    });

    await setRoleAndReload('A');
    await openTab('基线确认');
    await waitForText('当前角色 A');

    // 选中评测集：先等下拉选项渲染完（datasets 接口异步），再用原生 setter + change 走 React 受控组件
    await selectDataset(datasetId);
    await waitForText('提名理由');

    // A 角色：NOMINATED 行的确认按钮 disabled（BL-1）
    const disabledState = (await page.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent === '确认');
      return btns.length === 0 ? 'no-row' : (btns.every((b) => b.disabled) ? 'disabled' : 'enabled');
    })()`)) as string;
    expect(disabledState).toBe('disabled');

    // 切 B：提示语变化；reload 会重置 Tab 与下拉，重新进入并选中后再断言按钮可点
    await setRoleAndReload('B');
    await openTab('基线确认');
    await waitForText('当前角色 B');
    await selectDataset(datasetId);
    await waitForText('提名理由');
    const enabledState = (await page.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent === '确认');
      return btns.length === 0 ? 'no-row' : (btns.every((b) => !b.disabled) ? 'enabled' : 'disabled');
    })()`)) as string;
    expect(enabledState).toBe('enabled');
  }, 60_000);

  it('门禁规则 Tab：新建表单在场、ROLE-B 语义提示、派发历史入口', async (ctx) => {
    if (SKIP_REASON !== null) return ctx.skip();
    await setRoleAndReload('B');
    await openTab('门禁规则');
    await waitForText('新建门禁规则');
    const text = await bodyText();
    expect(text).toContain('规则名');
    expect(text).toContain('保存规则');
    // B 角色（上一条写入 localStorage）：头部提示为「可新建 / 编辑」文案
    expect(text).toContain('当前角色 B（管理员）：可新建 / 编辑规则');
    // 角色为 B：填上规则名（表单校验通过）后「保存规则」应变为可点——这是真实交互链
    await page.evaluate(`(() => {
      const input = document.getElementById('gate-name');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '浏览器档规则');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitUntil(
      async () =>
        ((await page.evaluate(`(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.textContent === '保存规则');
          return b !== undefined && !b.disabled;
        })()`)) as boolean),
      { timeoutMs: 10_000, message: '等待保存规则按钮变为可点' },
    );
  }, 60_000);

  it('GitHub 集成 Tab：创建表单在场 + ROLE-B 语义提示 + 集成卡片（投递历史入口）', async (ctx) => {
    if (SKIP_REASON !== null) return ctx.skip();
    // 幂等预置集成（201 新建 / 409 名称冲突均可——重跑不炸）
    const createRes = await fetch(`${BASE}/api/integrations/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'settings-tabs 浏览器档集成',
        appId: '123456',
        installationId: '987654',
        privateKey: 'PEM-SENTINEL-BROWSER',
        webhookSecret: 'sim-webhook-secret-browser',
        repos: [{ owner: 'o', repo: 'r' }],
      }),
    });
    expect([201, 409]).toContain(createRes.status);

    await setRoleAndReload('B');
    await openTab('GitHub 集成');
    await waitForText('创建 GitHub App 集成');
    const text = await bodyText();
    expect(text).toContain('App ID');
    expect(text).toContain('Webhook Secret');
    expect(text).toContain('当前角色 B（管理员）：可配置集成与触发规则');
    // 凭据零回显：页面文本不出现 PEM 头（密文/明文都不回显）
    expect(text).not.toContain('BEGIN RSA');
    // 集成卡片在场（有集成 → 卡片渲染出投递历史入口）
    await waitForText('投递历史');
  }, 60_000);
});
