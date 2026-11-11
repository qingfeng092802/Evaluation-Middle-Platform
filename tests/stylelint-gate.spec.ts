/**
 * stylelint 门禁自测（`[FE-01]` 交付物 6 / DoD 第 1 条）。
 *
 * ESLint 的 `AS-2` 只管 `.ts/.tsx`；`.css` 走另一条独立的门禁 `color-no-hex`。
 * 两条门禁互不覆盖 —— 只在 ESLint 里断言，等于放过后缀为 `.css` 的文件
 * 把 `#ff0000` 写进样式表。
 *
 * 同时锁定豁免范围：`app/globals.css` 是**全仓库唯一**允许写数值颜色的文件
 * （`DESIGN.md` §2.1 第 2 条）。如果哪天有人把豁免改成 `**\/*.css`，
 * 这条测试会红 —— 那份豁免是 Token 体系的立足点。
 */
import { describe, expect, it } from 'vitest';
import stylelint from 'stylelint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function lintCss(codeFilename: string, code: string): Promise<string[]> {
  const result = await stylelint.lint({
    code,
    codeFilename: resolve(ROOT, codeFilename),
    configFile: resolve(ROOT, '.stylelintrc.json'),
  });
  const warnings = result.results[0]?.warnings ?? [];
  return warnings.map((w) => `${w.rule ?? '?'}: ${w.text}`);
}

describe('color-no-hex · 组件样式里的裸色值必须报错', () => {
  it('components 下的 .css 写 #ff0000 被拦', async () => {
    const messages = await lintCss(
      'components/_probe.css',
      '.x { color: #ff0000; }\n',
    );
    expect(messages.some((m) => m.startsWith('color-no-hex:'))).toBe(true);
  });

  it('3 位缩写与 8 位带 alpha 也拦', async () => {
    const short = await lintCss('components/_probe.css', '.x { color: #fff; }\n');
    expect(short.some((m) => m.startsWith('color-no-hex:'))).toBe(true);

    const withAlpha = await lintCss('components/_probe.css', '.x { color: #ff000080; }\n');
    expect(withAlpha.some((m) => m.startsWith('color-no-hex:'))).toBe(true);
  });

  it('color-named 也拦：写 red 同样绕过 Token 体系', async () => {
    const messages = await lintCss('components/_probe.css', '.x { color: red; }\n');
    expect(messages.some((m) => m.startsWith('color-named:'))).toBe(true);
  });

  it('语义 Token 写法不报错', async () => {
    const messages = await lintCss(
      'components/_probe.css',
      '.x {\n  color: hsl(var(--eval-pass-fg));\n  background: hsl(var(--card));\n}\n',
    );
    expect(messages).toEqual([]);
  });
});

describe('豁免范围 · 只有 globals.css 能写数值颜色', () => {
  it('app/globals.css 允许 hex（Token 定义处）', async () => {
    const messages = await lintCss('app/globals.css', ':root { --x: #ff0000; }\n');
    expect(messages.some((m) => m.startsWith('color-no-hex:'))).toBe(false);
  });

  it('app 下非 globals.css 不给豁免', async () => {
    const messages = await lintCss('app/_probe.css', '.x { color: #ff0000; }\n');
    expect(messages.some((m) => m.startsWith('color-no-hex:'))).toBe(true);
  });
});
