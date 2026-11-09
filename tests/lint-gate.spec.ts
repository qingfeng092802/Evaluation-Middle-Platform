/**
 * Linter 门禁自测（`[FE-01]` DoD 第 1 条的后半句）。
 *
 * DoD 原文：「人为写一个 `#ff0000` 字面量 → Linter **报错**（测试该门禁真的生效）」。
 *
 * 之所以用 ESLint 的 Node API 而不是「人眼跑一次 `npm run lint`」：
 * 人眼验证的结论会随下一次改配置失效，而测试会一直守着。
 * 这里把**假想的组件源码**喂给真实配置，断言它被拦下——
 * 若有人为了让自己通过而放宽 `eslint.config.mjs`，这条会立刻红。
 *
 * 同时验证分层边界（`app`/`worker` → `lib` → `db` → `contracts`）与离线约束：
 * 那两条同样是「写错了也照样能跑」的规则，只有被测试才真的存在。
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function lint(filePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? '?'}: ${m.message}`);
}

const hasRule = (messages: string[], rule: string): boolean =>
  messages.some((m) => m.startsWith(`${rule}:`));

describe('AS-2 · 业务组件中的裸色值必须报错', () => {
  it('tsx 里的 #ff0000 字面量被拦', async () => {
    const messages = await lint(
      'app/_probe.tsx',
      `export function Probe() {\n  const c = "#ff0000";\n  return <span className={c}>x</span>;\n}\n`,
    );
    expect(hasRule(messages, 'no-restricted-syntax')).toBe(true);
    expect(messages.join('\n')).toContain('AS-2');
  });

  it('3 位 hex 也拦', async () => {
    const messages = await lint(
      'components/_probe.tsx',
      `export const A = () => <i className="text-[#fff]" />;\n`,
    );
    expect(hasRule(messages, 'no-restricted-syntax')).toBe(true);
  });

  it('内联 style 被拦', async () => {
    const messages = await lint(
      'components/_probe.tsx',
      `export const A = () => <i style={{ color: "red" }} />;\n`,
    );
    expect(hasRule(messages, 'no-restricted-syntax')).toBe(true);
  });

  it('合法写法（语义 Token 类名）不报错', async () => {
    const messages = await lint(
      'components/_probe.tsx',
      `export const A = () => <i className="bg-eval-pass-bg text-eval-pass num" />;\n`,
    );
    expect(messages).toEqual([]);
  });
});

describe('AS-1 · 渐变背景必须报错', () => {
  it('linear-gradient 被拦', async () => {
    const messages = await lint(
      'components/_probe.tsx',
      `export const A = () => <i className="bg-[linear-gradient(90deg,var(--primary),var(--card))]" />;\n`,
    );
    expect(hasRule(messages, 'no-restricted-syntax')).toBe(true);
    expect(messages.join('\n')).toContain('AS-1');
  });
});

describe('离线约束 · 禁用 next/font/google 与 CDN', () => {
  it('next/font/google 被拦', async () => {
    const messages = await lint(
      'app/_probe.tsx',
      `import { Inter } from 'next/font/google';\nexport const x = Inter;\n`,
    );
    expect(hasRule(messages, 'no-restricted-imports')).toBe(true);
  });

  it('lucide 深引被拦', async () => {
    const messages = await lint(
      'components/_probe.tsx',
      `import Clock from 'lucide-react/dist/esm/icons/clock.js';\nexport const x = Clock;\n`,
    );
    expect(hasRule(messages, 'no-restricted-imports')).toBe(true);
  });
});

describe('分层边界 · 单向依赖', () => {
  it('lib/operators 不得 import db', async () => {
    const messages = await lint(
      'lib/operators/_probe.ts',
      `import { query } from '../../db/repo/_client.js';\nexport const x = query;\n`,
    );
    expect(hasRule(messages, 'import/no-restricted-paths')).toBe(true);
  });

  it('db 不得 import lib', async () => {
    const messages = await lint(
      'db/repo/_probe.ts',
      `import { computeTargetCost } from '../../lib/cost/index.js';\nexport const x = computeTargetCost;\n`,
    );
    expect(hasRule(messages, 'import/no-restricted-paths')).toBe(true);
  });

  it('lib 不得 import app', async () => {
    const messages = await lint(
      'lib/_probe.ts',
      `import { GET } from '../app/api/runs/route.js';\nexport const x = GET;\n`,
    );
    expect(hasRule(messages, 'import/no-restricted-paths')).toBe(true);
  });

  it('合法方向 lib → contracts 不报错', async () => {
    const messages = await lint(
      'lib/_probe.ts',
      `import { RunStatus } from '@eval-platform/contracts';\nexport const x = RunStatus;\n`,
    );
    expect(messages).toEqual([]);
  });
});
