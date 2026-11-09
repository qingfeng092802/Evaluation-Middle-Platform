/**
 * 离线约束静态扫描（`[FE-01]` DoD：「全站零外部请求」）。
 *
 * DoD 原文：「构建产物中无 `fonts.googleapis.com` / CDN 域名（静态扫描断言）」。
 *
 * 断言的落点是**源码**而不是构建产物：构建产物要跑 `next build`（几十秒 + 依赖 `.next/`），
 * 而所有外部请求的来源必然先出现在源码里。`@fontsource` 是本地 npm 包，
 * 它的字体文件由 Next 打包进 `/_next/static/media/`，不发外网请求。
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 必须在源码里彻底消失的外部来源。 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /fonts\.googleapis\.com/, why: '构建期不联网（工程规则 §9）' },
  { pattern: /fonts\.gstatic\.com/, why: '构建期不联网（工程规则 §9）' },
  { pattern: /cdn\.jsdelivr\.net/, why: '禁用 CDN' },
  { pattern: /unpkg\.com/, why: '禁用 CDN' },
  { pattern: /cdnjs\.cloudflare\.com/, why: '禁用 CDN' },
  { pattern: /next\/font\/google/, why: '改用 @fontsource 本地打包' },
];

/**
 * 去掉注释后再扫描。
 *
 * 不加这一步，测试就会被自己的说明文字打红：`next.config.ts` 里写着
 * 「刻意**不**配置 `images.remotePatterns`」，`layout.tsx` 里解释「不用 `next/font/google`」——
 * 这些注释恰恰是**遵守约束的证据**，不是违规。
 *
 * 逐字符走一遍而不是用正则：`//` 出现在字符串里（`'https://…'`）时必须保留，
 * 否则「注释掉的部分是真违规」反而会漏报。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < src.length) {
    const ch = src[i] ?? '';
    const next = src[i + 1] ?? '';

    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? src.length : end;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

async function collect(dirAbs: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      await collect(abs, out);
      continue;
    }
    if (!/\.(ts|tsx|css|json)$/.test(entry.name)) continue;
    out.push(abs);
  }
}

async function sourceFiles(): Promise<{ rel: string; text: string }[]> {
  const abs: string[] = [];
  for (const d of ['app', 'components', 'lib']) await collect(join(ROOT, d), abs);
  return Promise.all(
    abs.map(async (a) => ({
      rel: relative(ROOT, a).split('\\').join('/'),
      text: stripComments(await readFile(a, 'utf8')),
    })),
  );
}

describe('零外部请求 · 源码中不得出现外部资源域名', () => {
  it('注释不参与判定，代码参与（防止「注释里写了就红」的假阳性）', async () => {
    // 用真实文件自证：layout.tsx 的注释里含 `next/font/google` 说明，但不应被计入
    const layout = await readFile(join(ROOT, 'app', 'layout.tsx'), 'utf8');
    expect(layout).toContain('next/font/google'); // 注释里确实提到了
    expect(stripComments(layout)).not.toContain('next/font/google'); // 但剥注释后没有
  });

  it('app / components / lib 下无 fonts.googleapis / CDN / next/font/google', async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(10);

    const hits: string[] = [];
    for (const f of files) {
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(f.text)) hits.push(`${f.rel} → ${rule.pattern.source}（${rule.why}）`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('字体确实来自本地包（layout.tsx 引 @fontsource）', async () => {
    const layout = await readFile(join(ROOT, 'app', 'layout.tsx'), 'utf8');
    expect(layout).toContain('@fontsource/inter');
    expect(layout).toContain('@fontsource/jetbrains-mono');
  });

  it('next.config.ts 未配置 images.remotePatterns（否则等于开了外链白名单）', async () => {
    const cfg = stripComments(await readFile(join(ROOT, 'next.config.ts'), 'utf8'));
    expect(cfg).not.toContain('remotePatterns');
  });
});
