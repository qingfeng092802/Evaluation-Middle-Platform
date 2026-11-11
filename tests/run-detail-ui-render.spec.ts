/**
 * `PG-03`/`PG-04` 的**真实渲染**断言（#1 浏览器交互的可机器验证部分）。
 *
 * 为什么要有这一层：`runs-ui.spec.ts` 只锁纯函数（`progressLabel` / `shouldPoll`），
 * 它能证明「文案算对了」，但证明不了「组件真的用了它」。四条浏览器验收点里，
 * 有三条本质是**结构**问题，可以在服务端渲染层面直接锁死：
 *
 *  - **进度条位宽不抖**：计数从 99 → 100 时，进度条与计数文字的外框不能变宽。
 *    这里断言计数区带 `min-w-[22ch]`、数字区带 `.num`（`tabular-nums`），
 *    以及 `<progress>` 用 `value/max` 而不是内联宽度 —— 三者缺一都会抖。
 *  - **终态停轮询**：`shouldPoll` 是纯函数，已在 `runs-ui.spec.ts` 锁死；
 *    这里补一条「终态不渲染运行中条 / 实时更新中」的渲染断言。
 *  - **`Esc` 关闭且焦点归还**：由 Radix Dialog 提供（`components/ui/sheet.tsx`），
 *    这里不做 DOM 事件模拟（jsdom 未安装），改为断言「抽屉基于 Radix 且带关闭按钮」，
 *    真实交互仍由浏览器复核。
 *  - **刷新后抽屉关闭**：断言抽屉开关状态**只存在 React state、不写 URL** ——
 *    写进 URL 的抽屉刷新后会重新打开，这正是需要避免的反模式。
 *
 * 注意：本文件用 `react-dom/server` 做静态标记断言；不需要 jsdom，
 * 因为全部断言都能从**静态标记**里读出来。
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunStatus } from '@eval-platform/contracts';
import { LiveRunProgressBar } from '../components/runs/live-run-progress-bar';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function renderBar(props: {
  completedCount: number;
  totalCount: number;
  failedCount: number;
  runStatus: RunStatus;
  live: boolean;
}): string {
  return renderToStaticMarkup(
    React.createElement(LiveRunProgressBar, {
      ...props,
      score: null,
      passed: null,
      latencyMs: null,
    }),
  );
}

describe('#1-3 进度条位宽不抖', () => {
  it('计数区固定最小宽度（99→100 时外框不变）', () => {
    const html = renderBar({
      completedCount: 99,
      totalCount: 300,
      failedCount: 0,
      runStatus: 'RUNNING',
      live: true,
    });
    expect(html).toContain('min-w-[22ch]');
  });

  it('计数文字带 .num（tabular-nums），否则数字换位仍会抖动', () => {
    const html = renderBar({
      completedCount: 99,
      totalCount: 300,
      failedCount: 0,
      runStatus: 'RUNNING',
      live: true,
    });
    expect(html).toMatch(/class="[^"]*\bnum\b[^"]*min-w-\[22ch\]|min-w-\[22ch\][^"]*\bnum\b/);
  });

  it('进度条用原生 <progress> 的 value/max，不用内联宽度（避免 Tailwind 插值失效）', () => {
    const html = renderBar({
      completedCount: 1,
      totalCount: 3,
      failedCount: 0,
      runStatus: 'RUNNING',
      live: true,
    });
    expect(html).toContain('<progress');
    expect(html).toContain('value="33.33333333333333"');
    expect(html).toContain('max="100"');
    // AS-2：不得出现内联 style 宽度
    expect(html).not.toMatch(/style="[^"]*width/i);
  });

  it('从 99/100 到 100/100，计数区的外框类名完全一致', () => {
    const a = renderBar({
      completedCount: 99,
      totalCount: 100,
      failedCount: 0,
      runStatus: 'RUNNING',
      live: true,
    });
    const b = renderBar({
      completedCount: 100,
      totalCount: 100,
      failedCount: 0,
      runStatus: 'RUNNING',
      live: true,
    });
    const wrapOf = (html: string): string =>
      /<span class="([^"]*min-w-\[22ch\][^"]*)"/.exec(html)?.[1] ?? '';
    expect(wrapOf(a)).not.toBe('');
    expect(wrapOf(a)).toBe(wrapOf(b));
  });
});

describe('#1-1 终态停轮询（渲染层佐证）', () => {
  it('live=false 时不渲染「实时更新中」', () => {
    const html = renderBar({
      completedCount: 50,
      totalCount: 50,
      failedCount: 0,
      runStatus: 'COMPLETED',
      live: false,
    });
    expect(html).not.toContain('实时更新中');
  });

  it('live=true 时渲染「实时更新中」', () => {
    const html = renderBar({
      completedCount: 1,
      totalCount: 50,
      failedCount: 0,
      runStatus: 'RUNNING',
      live: true,
    });
    expect(html).toContain('实时更新中');
  });

  it('PENDING 显示「等待调度」而不是 0 / N', () => {
    const html = renderBar({
      completedCount: 0,
      totalCount: 300,
      failedCount: 0,
      runStatus: 'PENDING',
      live: true,
    });
    expect(html).toContain('等待调度');
    expect(html).not.toContain('已完成 0 / 300');
  });
});

describe('#1-4 刷新后抽屉关闭（状态不写 URL）', () => {
  it('抽屉开关只来自 React state，不读取 / 写入 searchParams', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    // 开关状态是 useState
    expect(src).toMatch(/const \[openCaseKey, setOpenCaseKey\] = React\.useState/);
    // 不得把 caseKey 落到查询参数（落 URL ⇒ 刷新后自动重开）
    expect(src).not.toMatch(/searchParams\.(get|set)\(\s*['"]case/);
    expect(src).not.toMatch(/router\.(push|replace)\([^)]*caseKey/);
    // 关闭时清空 state
    expect(src).toMatch(/if \(!next\) setOpenCaseKey\(null\)/);
  });
});

describe('#1-2 Esc 关闭且焦点归还（结构前提）', () => {
  it('抽屉基于 Radix Dialog（自带 focus trap / Esc / 焦点归还）', async () => {
    const src = await readFile(resolve(ROOT, 'components', 'ui', 'sheet.tsx'), 'utf8');
    expect(src).toContain("@radix-ui/react-dialog");
    expect(src).toContain('DialogPrimitive.Portal');
    expect(src).toContain('DialogPrimitive.Content');
  });

  it('抽屉里有可聚焦的「关闭」按钮（键盘可达的关闭路径）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    expect(src).toContain('SheetClose');
    expect(src).toMatch(/SheetClose[\s\S]{0,200}关闭/);
  });

  /**
   * 真浏览器实测暴露的缺陷（2026-11-09）：抽屉是**受控**的，且没有
   * `SheetTrigger` —— Radix 关闭时只知道「要归还给 Trigger」，而 Trigger 不存在，
   * 于是焦点落到 `<body>`，`Esc` 之后键盘用户丢掉位置。
   *
   * 修法是显式接管：记住打开抽屉的那个元素，关闭时 `preventDefault` 掉
   * Radix 的默认行为并自己 `focus()` 回去。这里断言**接管代码存在**，
   * 真实的「焦点确实回到按钮上」由 `tests/run-detail-keyboard.spec.ts` 在浏览器里验。
   */
  it('受控抽屉必须显式接管关闭后的焦点归还（无 SheetTrigger 时 Radix 无处可还）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    expect(src).toContain('onCloseAutoFocus');
    expect(src).toMatch(/onCloseAutoFocus[\s\S]{0,300}preventDefault/);
    expect(src).toMatch(/onCloseAutoFocus[\s\S]{0,400}\.focus\(\)/);
  });
});

/**
 * `J`/`K` 键盘导航（`DESIGN.md` §4.3）。
 *
 * 这里只锁**结构前提**；行为本身（按 J 真的换人、输入框里不吞字母）
 * 必须在真实浏览器里验 —— 见 `tests/run-detail-keyboard.spec.ts`。
 *
 * 结构上最容易写错的两处，静态就能拦住：
 *  1. 监听挂 `window` 而不是 Sheet 容器 —— 挂 window 的话抽屉关掉后监听还在；
 *  2. 作用域排除漏掉 `input` / `textarea` / `select` / `[contenteditable]`
 *     中的任何一个 —— 用户在对应的框里就打不出 j 和 k。
 */
describe('#1-5 J/K 键盘导航（结构前提）', () => {
  it('监听挂在 Sheet 容器上，不是 window', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    expect(src).toMatch(/sheetEl\.addEventListener\(\s*'keydown'/);
    expect(src).toMatch(/sheetEl\.removeEventListener\(\s*'keydown'/);
    expect(src).not.toMatch(/window\.addEventListener\(\s*'keydown'/);
  });

  it('作用域排除四件套齐全：input / textarea / select / [contenteditable]', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    const guard = /target\.closest\(\s*'([^']*)'\s*\)/.exec(src)?.[1] ?? '';
    expect(guard, '必须有 target.closest(...) 的作用域判断').not.toBe('');
    for (const sel of ['input', 'textarea', 'select', 'contenteditable']) {
      expect(guard, `作用域排除必须含 ${sel}`).toContain(sel);
    }
  });

  it('用 callback ref 存容器节点：Radix Portal 内容晚于 effect 挂载，ref 赋值不触发重渲染', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    // 用 useState<HTMLDivElement | null> + ref={setSheetEl}：节点到位时 setState
    // 带来一次重渲染，effect 才会真正绑定监听。
    // 用 useRef 时 effect 首跑读到 null，之后 ref 赋值不触发重渲染 ⇒ 监听永远挂不上，
    // 且失败完全静默（按 J 没反应，无报错）。
    expect(src).toMatch(/useState<HTMLDivElement \| null>/);
    expect(src).toMatch(/ref=\{setSheetEl\}/);
  });
});
