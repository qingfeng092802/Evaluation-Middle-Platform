/**
 * 设计规范的可机器验证部分（`[FE-01]` DoD）。
 *
 * 三条 DoD 无法靠人眼验收，只能靠静态断言：
 *  1. 「`prefers-reduced-motion: reduce` 下所有动画归零」；
 *  2. 「任意表格列中的数字使用 `.num`」——前提是 `.num` 真的存在且真的带 `tabular-nums`；
 *  3. 「`DESIGN.md` §2.1 第 3 条：每个 Token 必须有浅色与深色两个值」——
 *     漏一个深色值不会报错，只会在深色模式里悄悄变成继承色。
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function globalsCss(): Promise<string> {
  return readFile(resolve(ROOT, 'app', 'globals.css'), 'utf8');
}

/** 取出某个选择器块里的自定义属性名（只取本层，不递归）。 */
function tokensIn(css: string, selector: string): string[] {
  const start = css.indexOf(selector);
  if (start === -1) return [];
  const open = css.indexOf('{', start);
  if (open === -1) return [];
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = css.slice(open, end);
  return [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1] ?? '');
}

describe('动效预算（DESIGN §6.2）', () => {
  it('存在 prefers-reduced-motion: reduce 且把 animation/transition 归零', async () => {
    const css = await globalsCss();
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(css).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it('全站只有一处 media query（不是每页各写一份，那样必然会漏）', async () => {
    const css = await globalsCss();
    // 只数真实的 `@media` 声明：注释里也提到了这串关键词，不能算进去。
    const count = [...css.matchAll(/@media\s*\(\s*prefers-reduced-motion/g)].length;
    expect(count).toBe(1);
  });
});

describe('数字排版铁律（DESIGN §3.2）', () => {
  it('.num 带 tabular-nums 且带 slashed-zero', async () => {
    const css = await globalsCss();
    expect(css).toMatch(/\.num\s*\{[^}]*tabular-nums[^}]*\}/s);
    expect(css).toMatch(/\.num\s*\{[^}]*slashed-zero[^}]*\}/s);
  });

  it('.num-mono 用等宽栈（时间戳列）', async () => {
    const css = await globalsCss();
    expect(css).toMatch(/\.num-mono\s*\{[^}]*JetBrains Mono[^}]*\}/s);
  });
});

/**
 * 与主题无关的结构性 Token。
 *
 * `DESIGN.md` §2.2 里 `--radius` 的深色列写的是 `—`：圆角不随主题变。
 * 这里显式列出而不是「凡深色缺的都放过」——那份白名单如果变成通配，
 * 这条断言就等于取消了。
 */
const THEME_INDEPENDENT = new Set(['--radius']);

describe('Token 双值（DESIGN §2.1 第 3 条）', () => {
  it('每个颜色 Token 都有对应的深色值', async () => {
    const css = await globalsCss();
    const light = tokensIn(css, ':root').filter((t) => !THEME_INDEPENDENT.has(t));
    const dark = tokensIn(css, '.dark');

    expect(light.length).toBeGreaterThan(30);
    const missing = light.filter((t) => !dark.includes(t));
    expect(missing).toEqual([]);
  });

  it('深色里没有浅色没定义过的孤儿 Token', async () => {
    const css = await globalsCss();
    const light = tokensIn(css, ':root');
    const dark = tokensIn(css, '.dark');
    const orphans = dark.filter((t) => !light.includes(t));
    expect(orphans).toEqual([]);
  });
});
