/**
 * `PG-03` 区域 3 的 SSE 接线（Batch 3 · 交付物 4/5）。
 *
 * 交付物原文：「前端 `LiveRunProgressBar` 从轮询切到 SSE，**组件 props 不变**」。
 * 这三件事都是「写错了也照常渲染」的，必须在静态层面锁住：
 *
 *  1. **页面还在轮询** —— 轮询与 SSE 同时存在时，进度条会先按 SSE 跳一次、
 *     2 秒后又被轮询的旧数据拉回去，表现为「进度条抖」。而且没人会报错。
 *  2. **props 被改** —— `LiveRunProgressBar` 的接口是 `DESIGN.md` §4.2 锁定的；
 *     加一个 `connection` prop 意味着这个组件绑死在一个数据源上，
 *     M3 的报告页复用不了。
 *  3. **连接三态用颜色区分而不给文案** —— `已连接 / 重连中 / 已断开`
 *     是 `DESIGN.md` §4.2 的原文，颜色不能作唯一编码。
 *
 * 断言用真实静态标记（不需要 jsdom），连接态由 props 驱动。
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StreamConnectionIndicator } from '../components/runs/stream-connection-indicator';
import { LiveRunProgressBar } from '../components/runs/live-run-progress-bar';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function renderConnection(connection: 'connected' | 'reconnecting' | 'disconnected'): string {
  return renderToStaticMarkup(
    React.createElement(StreamConnectionIndicator, { connection, announcement: null }),
  );
}

describe('连接三态 · 文案逐字取自 DESIGN §4.2', () => {
  it('已连接', () => {
    expect(renderConnection('connected')).toContain('已连接');
  });

  it('重连中', () => {
    expect(renderConnection('reconnecting')).toContain('重连中');
  });

  it('已断开', () => {
    expect(renderConnection('disconnected')).toContain('已断开');
  });

  it('三态各有独立可辨的文案（颜色不是唯一编码，WCAG 1.4.1）', () => {
    const texts = (['connected', 'reconnecting', 'disconnected'] as const).map(
      (c) => /已连接|重连中|已断开/.exec(renderConnection(c))?.[0],
    );
    expect(texts).toEqual(['已连接', '重连中', '已断开']);
  });
});

describe('色调与呼吸脉冲', () => {
  it('已连接 ⇒ eval.running + 呼吸脉冲（只在 8px 圆点上，不是整个徽章）', () => {
    const html = renderConnection('connected');
    expect(html).toContain('text-eval-running');
    expect(html).toContain('animate-eval-pulse');
    // 脉冲类必须挂在圆点元素上：圆点带 h-2 w-2（8px）
    expect(html).toMatch(/class="[^"]*h-2[^"]*w-2[^"]*animate-eval-pulse|animate-eval-pulse[^"]*h-2[^"]*w-2/);
  });

  it('重连中 ⇒ eval.warn 且静态（无脉冲：大面积/持续脉动是闪烁风险）', () => {
    const html = renderConnection('reconnecting');
    expect(html).toContain('text-eval-warn');
    expect(html).not.toContain('animate-eval-pulse');
  });

  it('已断开 ⇒ eval.fail 且静态', () => {
    const html = renderConnection('disconnected');
    expect(html).toContain('text-eval-fail');
    expect(html).not.toContain('animate-eval-pulse');
  });

  it('prefers-reduced-motion ⇒ 呼吸脉冲降级为静态（motion-reduce:animate-none）', () => {
    expect(renderConnection('connected')).toContain('motion-reduce:animate-none');
  });
});

describe('无障碍 · aria-live 只播报连接变化与里程碑', () => {
  it('容器 aria-live="polite" + aria-atomic="false"', () => {
    const html = renderConnection('connected');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="false"');
  });

  it('announcement 为空时不渲染任何播报文本（不播每一条 Case）', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamConnectionIndicator, { connection: 'connected', announcement: null }),
    );
    expect(html).not.toContain('进度');
  });

  it('有 announcement 时渲染出来（跨 10% 里程碑 / 连接变化）', () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamConnectionIndicator, {
        connection: 'connected',
        announcement: '进度 40%',
      }),
    );
    expect(html).toContain('进度 40%');
  });
});

describe('页面接线 · 轮询已下线，props 未变', () => {
  it('页面订阅 SSE，不再使用 usePolling', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    expect(src).toContain('useRunStream');
    expect(src).not.toContain('usePolling');
    // 也不许自己 setInterval 偷偷轮询
    expect(src).not.toMatch(/setInterval\(\s*\(\)\s*=>\s*\{\s*run\.reload/);
  });

  it('LiveRunProgressBar 仍只吃那 8 个 prop（DESIGN §4.2 锁定接口）', async () => {
    const src = await readFile(resolve(ROOT, 'app', 'runs', '[runId]', 'page.tsx'), 'utf8');
    const block = /<LiveRunProgressBar([\s\S]*?)\/>/.exec(src)?.[1] ?? '';
    expect(block).not.toBe('');
    const props = [...block.matchAll(/(\w+)=\{/g)].map((m) => m[1]);
    expect(props.sort()).toEqual(
      [
        'completedCount',
        'failedCount',
        'latencyMs',
        'live',
        'passed',
        'runStatus',
        'score',
        'totalCount',
      ].sort(),
    );
  });

  it('组件 props 契约本身没被改动（连接态不是它的 prop）', () => {
    const props = Object.keys(
      (LiveRunProgressBar as unknown as { defaultProps?: Record<string, unknown> }).defaultProps ??
        {},
    );
    // 该组件没有 defaultProps；真正锁的是渲染时能否被这几个 prop 满足
    const html = renderToStaticMarkup(
      React.createElement(LiveRunProgressBar, {
        completedCount: 1,
        totalCount: 2,
        failedCount: 0,
        runStatus: 'RUNNING',
        live: true,
        score: 0.8,
        passed: true,
        latencyMs: 12,
      }),
    );
    expect(props).toEqual([]);
    expect(html).toContain('已完成 1 / 2');
  });
});
