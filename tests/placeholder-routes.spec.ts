/**
 * P2 / P5 / P6 占位路由（需求方 2026-11-10「方案 A」裁定）。
 *
 * ## 为什么这三个页面必须存在，且必须「什么都不做」
 *
 * `PG-08` 属 **M3**、`PG-07` 属 **M4**、`PG-09` 属 **M2（模型网关 Tab）/ M4（门禁规则 Tab）**。
 * 补齐它们需要**新增契约 + 新增迁移 + 新增路由**，三者都在 M1 授权之外
 * （`SPEC-M1` §1.2 明令不得新增/修改契约文件）。所以 M1 只留占位。
 *
 * 占位页最容易犯的两种错，都「跑起来完全正常」：
 *  1. **接了假数据** —— 页面看着是通的，验收时才发现整页都是编的；
 *  2. **做成死链 / 404** —— 用户点过去看到 Not Found，以为是 bug。
 *
 * 因此这里断言的不是「有个页面」，而是**页面说清了它为什么不在**、**它没有取任何数据**。
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_NOTICES, placeholderNotice, type PlaceholderKey } from '../lib/ui/derive.js';
import { PlaceholderPage } from '../components/shell/placeholder-page.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 文案层（纯函数）
// ---------------------------------------------------------------------------

describe('placeholderNotice · 里程碑归属逐条对齐 SPEC', () => {
  it('PG-08 报告对比属 M3', () => {
    expect(placeholderNotice('pg08').milestone).toBe('M3');
  });

  it('PG-07 算子库属 M4', () => {
    expect(placeholderNotice('pg07').milestone).toBe('M4');
  });

  it('PG-09 管理配置是 M2（模型网关）/ M4（门禁规则）两段', () => {
    // 不是单一里程碑：M2 先点亮模型网关 Tab，M4 才有门禁规则。
    expect(placeholderNotice('pg09').milestone).toBe('M2 / M4');
  });

  it('每个占位都有页面编号，用户能对上需求文档', () => {
    for (const key of Object.keys(PLACEHOLDER_NOTICES) as PlaceholderKey[]) {
      expect(placeholderNotice(key).pageId).toMatch(/^PG-\d{2}$/);
    }
  });

  it('文案里必须出现「上线」二字（说清是"还没到"而非"坏了"）', () => {
    for (const key of Object.keys(PLACEHOLDER_NOTICES) as PlaceholderKey[]) {
      expect(placeholderNotice(key).message).toContain('上线');
    }
  });
});

// ---------------------------------------------------------------------------
// 渲染层
// ---------------------------------------------------------------------------

describe('PlaceholderPage · 渲染里程碑原文', () => {
  function html(key: PlaceholderKey): string {
    return renderToStaticMarkup(React.createElement(PlaceholderPage, { noticeKey: key }));
  }

  it('PG-08 渲染出「M3」', () => {
    expect(html('pg08')).toContain('M3');
  });

  it('PG-07 渲染出「M4」', () => {
    expect(html('pg07')).toContain('M4');
  });

  it('PG-09 渲染出「M2 / M4」', () => {
    expect(html('pg09')).toContain('M2 / M4');
  });

  it('渲染页面编号（PG-xx），便于对照需求文档', () => {
    expect(html('pg08')).toContain('PG-08');
  });

  it('只用语义 Token 类名，不产出裸色值（check:tokens 的一致性）', () => {
    for (const key of Object.keys(PLACEHOLDER_NOTICES) as PlaceholderKey[]) {
      const markup = html(key);
      expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(markup).not.toMatch(/\brgba?\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 路由文件本身：必须存在，且**不得取数据**
// ---------------------------------------------------------------------------

const ROUTES: readonly { file: readonly string[]; key: PlaceholderKey }[] = [
  { file: ['app', 'runs', 'compare', 'page.tsx'], key: 'pg08' },
  { file: ['app', 'evaluators', 'page.tsx'], key: 'pg07' },
  { file: ['app', 'settings', 'page.tsx'], key: 'pg09' },
];

describe('占位路由 · 文件存在且不连数据', () => {
  it('三个 route 文件都在', async () => {
    for (const r of ROUTES) {
      const src = await readFile(resolve(ROOT, ...r.file), 'utf8');
      expect(src.length).toBeGreaterThan(0);
    }
  });

  it('每个 route 都引用自己的 noticeKey（不复制粘贴错位）', async () => {
    for (const r of ROUTES) {
      const src = await readFile(resolve(ROOT, ...r.file), 'utf8');
      expect(src).toContain(`noticeKey="${r.key}"`);
    }
  });

  it('占位页不得调用 useApi / fetch / apiGet（不连数据）', async () => {
    for (const r of ROUTES) {
      const src = await readFile(resolve(ROOT, ...r.file), 'utf8');
      expect(src).not.toContain('useApi');
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('apiGet');
      expect(src).not.toContain('@eval-platform/contracts');
    }
  });

  it('占位页是无状态的服务端组件（没有 use client / useState）', async () => {
    for (const r of ROUTES) {
      const src = await readFile(resolve(ROOT, ...r.file), 'utf8');
      expect(src).not.toContain("'use client'");
      expect(src).not.toContain('useState');
    }
  });
});

// ---------------------------------------------------------------------------
// 与现有导航的一致性
// ---------------------------------------------------------------------------

describe('占位路由与侧栏的关系', () => {
  it('/evaluators 与 /settings 在侧栏里是置灰项（不是死链）', async () => {
    const src = await readFile(resolve(ROOT, 'lib', 'ui', 'nav.ts'), 'utf8');
    // 两个入口都存在且都标了 disabled
    expect(src).toMatch(/href:\s*'\/evaluators'[^}]*disabled:\s*true/);
    expect(src).toMatch(/href:\s*'\/settings'[^}]*disabled:\s*true/);
  });
});
