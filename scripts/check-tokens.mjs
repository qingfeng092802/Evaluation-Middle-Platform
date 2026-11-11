#!/usr/bin/env node
/**
 * `npm run check:tokens` —— AS-1 / AS-2 的静态扫描补充（`工程规则` §4.1）。
 *
 * 为什么在 ESLint 之外还要有这个脚本：
 * ESLint 的 `no-restricted-syntax` 只看 AST 字面量，抓不到**字符串里拼出来的**颜色
 * （`className="bg-[linear-gradient(90deg,#000,#fff)]"`），也抓不到 `.css` 之外的
 * 模板字符串。这个脚本按文本扫描，覆盖那部分，两者互为补集。
 *
 * 与 ESLint 的关系：**重叠不是浪费**。门禁的价值在于「任何一条路径都拦得住」，
 * 而不是「每条规则只实现一次」。
 *
 * 扫描范围：`app/`、`components/`、`lib/` 下的 `.ts` / `.tsx` / `.css`。
 * 豁免：`app/globals.css`（Token 的唯一合法归宿）、`*.test.*` / `tests/`。
 *
 * 本文件同时导出 `scanSource` / `scanSources` 供单测直接调用——
 * 一个从不被测试的门禁脚本，很可能只是「存在」而从不生效。
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 违规类型。`inline-style` 无法被 ESLint 之外的文本扫描完全覆盖，这里只做启发式。 */
export const RULES = {
  hex: '禁止裸写 #hex，请用语义 Token（如 bg-eval-pass-bg）',
  rgb: '禁止裸写 rgb()/rgba()，请用语义 Token',
  hsl: '禁止裸写 hsl() 数值，只允许 hsl(var(--token))',
  gradient: '禁止渐变背景（AS-1）',
  'inline-style': '禁止内联 style，颜色与间距一律走 Token / Tailwind 类（AS-2）',
};

/** `#abc` / `#aabbcc` / `#aabbccdd`。刻意不含 4/5 位——不是合法 CSS 颜色长度。 */
const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const RGB_RE = /\brgba?\(/g;
/** `hsl(` / `hsla(`，但排除 `hsl(var(` 这种合法用法。 */
const HSL_RE = /\bhsla?\((?!\s*var\()/g;
const GRADIENT_RE = /\b(?:linear|radial|conic)-gradient\(/g;
const INLINE_STYLE_RE = /\bstyle=\{/g;

/**
 * 判断 `#xxx` 是不是「颜色语境」。
 *
 * 单纯匹配 `#` 会误伤 `href="#section"`、`#123456` 这类 slug。
 * 判据：前面不能是 `href=` / `url(#`（SVG 引用），且不能紧跟在字母数字后。
 */
function isColorContext(source, index, matchLength) {
  const before = source.slice(Math.max(0, index - 12), index);
  if (/href=\s*["']?$/.test(before)) return false;
  if (/url\(\s*["']?$/.test(before)) return false;
  if (before.endsWith('#') && /\\$/.test(before)) return false;
  // `&#123;` 这类 HTML 实体
  if (before.endsWith('&')) return false;
  return matchLength > 0;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * 扫描单个文件内容。
 *
 * @param {string} file 相对路径（仅用于结果归档与单测断言）
 * @param {string} source 文件原文
 * @returns {Array<{file: string, line: number, rule: string, match: string, message: string}>}
 */
export function scanSource(file, source) {
  const issues = [];

  for (const m of source.matchAll(HEX_RE)) {
    const index = m.index ?? 0;
    if (!isColorContext(source, index, m[0].length)) continue;
    issues.push({
      file,
      line: lineOf(source, index),
      rule: 'hex',
      match: m[0],
      message: RULES.hex,
    });
  }

  for (const [rule, re] of [
    ['rgb', RGB_RE],
    ['hsl', HSL_RE],
    ['gradient', GRADIENT_RE],
    ['inline-style', INLINE_STYLE_RE],
  ]) {
    for (const m of source.matchAll(re)) {
      const index = m.index ?? 0;
      issues.push({
        file,
        line: lineOf(source, index),
        rule,
        match: m[0],
        message: RULES[rule],
      });
    }
  }

  // 同一行同一规则只报一次：`rgba(0,0,0)` 会同时命中 rgb 的括号，重复提示没有信息量
  const seen = new Set();
  return issues.filter((i) => {
    const key = `${i.line}:${i.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 扫描多个文件并打平。
 * @param {ReadonlyArray<{file: string, source: string}>} entries
 */
export function scanSources(entries) {
  return entries.flatMap((e) => scanSource(e.file, e.source));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** 扫描目录（相对 `src/`）与豁免文件（相对 `src/`）。 */
const SCAN_DIRS = ['app', 'components', 'lib'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.css']);
/** Token 的唯一合法归宿；`DESIGN.md` §2.1 明确它是全仓库唯一允许出现 hex/HSL 数值的文件。 */
const ALLOWED = new Set([
  'app/globals.css',
  'tailwind.config.ts',
  'components.json',
]);

async function walk(dirAbs, out) {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // 目录不存在（例如尚未建 `components/`）不算错误
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
      continue;
    }
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    if (rel.endsWith('.d.ts')) continue;
    const dot = abs.lastIndexOf('.');
    if (dot === -1 || !EXTENSIONS.has(abs.slice(dot))) continue;
    out.push({ abs, rel });
  }
}

async function main() {
  const files = [];
  for (const d of SCAN_DIRS) await walk(join(ROOT, d), files);

  const entries = [];
  for (const f of files) {
    entries.push({ file: f.rel, source: await readFile(f.abs, 'utf8') });
  }

  const issues = scanSources(entries);

  if (issues.length === 0) {
    console.log(`[check:tokens] 通过：${entries.length} 个文件，无裸色值 / 渐变 / 内联样式。`);
    return;
  }

  console.error(`[check:tokens] 发现 ${issues.length} 处违规：\n`);
  for (const i of issues) {
    console.error(`  ${i.file}:${i.line}  [${i.rule}]  ${i.match}`);
    console.error(`    ${i.message}`);
  }
  console.error('\n修正：把所有颜色改为 DESIGN.md §2 的语义 Token 类名。');
  process.exitCode = 1;
}

// 仅在被直接执行时跑 CLI；被 `import` 时只暴露函数（单测用）
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('check-tokens.mjs') || process.argv[1].endsWith('check-tokens.mjs'.replace(/\//g, '\\')));

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[check:tokens] 运行失败：', err);
    process.exitCode = 1;
  });
}
