#!/usr/bin/env tsx
/**
 * `B-01`/`B-02` 的构建前门禁：**不许在 dev 产物上直接构建，也不许在混合产物上起服务**。
 *
 * ## 复盘
 *
 * 2026-11-09 独立验收看到「`/api/datasets` 有数据，页面却停在空状态」。根因不在
 * 页面代码，在 `.next`：
 *
 * ```
 * .next/BUILD_ID                 18:34  ← 一次 next build（生产）
 * .next/app-build-manifest.json  19:14  ← 一个还活着的 next dev 覆写了它
 * .next/static/development/      19:09  ← dev 的静态产物与生产产物并存
 * ```
 *
 * 生产构建的 chunk 名带内容哈希，`next dev` 的 chunk 名是固定的
 * （`main-app.js` / `polyfills.js` / `layout.css`）。两套混在同一个 `.next` 里，
 * 服务端按 dev 清单渲染 HTML、客户端按生产清单找文件 ⇒ 三个关键资源全部 404
 * ⇒ 没有客户端 JS，也就没有水合 ⇒ `useApi` 拉回的数据永远进不了表格。
 * 删掉 `.next` 后用同一份代码立即恢复（3 条数据 ⇒ 3 行）。
 *
 * ## 判据为什么是「产物指纹」而不是「查进程」
 *
 * 查「有没有 next dev 在跑」在 Windows 上要解析 WMI，脆且慢。而混合产物一定会
 * 留下可判读的指纹：**生产构建必有 `BUILD_ID`，dev 必有 `static/development/`**。
 * 两者并存就说明已经混过，与此刻进程是否还在跑无关 —— 进程停了，坏产物还留在
 * 盘上，下一次 `next start` 照样白屏。
 *
 * ## 这件事能做到什么、做不到什么
 *
 * 做得到：`npm run build` 之前拦住已被污染的 `.next`，并给出可执行的处理指令。
 * 做不到：证明 dev server 一定停了。所以这里**只拦不删** —— 在活着的 dev server
 * 底下删 `.next` 会把 dev 也一起弄坏；清理交给人在确认停掉后执行
 * `npm run clean:next`。
 *
 * 用法：
 *     npx tsx scripts/check-next-artifacts.ts          # 检查（被 prebuild 调用）
 *     npx tsx scripts/check-next-artifacts.ts --json   # 机器可读
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeNoNextRunning, listNodeProcesses, type NodeProcess, type PreconditionIssue } from './next-processes.js';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `.next` 的关键产物指纹。全部是「存在与否」，不读内容。 */
export interface ArtifactFingerprint {
  /** `next build` 一定会写。dev 不写。 */
  readonly hasBuildId: boolean;
  /** `next dev` 一定会写。生产构建不写。 */
  readonly hasDevStatic: boolean;
  /** App Router 的构建清单；被 dev 覆写过就是混合产物的直接证据。 */
  readonly hasAppBuildManifest: boolean;
  /** `.next/server` —— 任意一次构建或 dev 都会产生，用于识别「构建到一半挂了」。 */
  readonly hasServerDir?: boolean;
}

export type ArtifactIssueCode =
  | 'MIXED_ARTIFACTS'
  | 'DANGLING_MANIFEST'
  | 'MISSING_BUILD_ID'
  /** 只有 `dev:all` 会产出：生产产物在，dev 即将把它们混在一起。 */
  | 'PROD_ARTIFACTS_PRESENT';

export interface ArtifactIssue {
  readonly code: ArtifactIssueCode;
  readonly message: string;
}

const CLEAN_HINT = '请先停掉 next dev，再执行 `npm run clean:next`，然后重新构建。';

/**
 * 纯判定：指纹 → 问题清单。空数组表示干净。
 *
 * 三种脏状态各有明确成因，不合并成一句「.next 不干净」：
 *  - `MIXED_ARTIFACTS`：生产与 dev 两套产物共存 —— **本次事故**；
 *  - `DANGLING_MANIFEST`：有 dev 的清单却没有任何静态产物，单独出现说明
 *    某次写入被中断（磁盘满 / 进程被杀），客户端会拿到 404 的 chunk；
 *  - `MISSING_BUILD_ID`：已经产出 `server/` 却没有 `BUILD_ID` —— 构建中途失败，
 *    这类残留最容易在下次构建时被当成缓存复用。
 */
export function detectMixedArtifacts(fp: ArtifactFingerprint): readonly ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];

  if (fp.hasBuildId && fp.hasDevStatic) {
    issues.push({
      code: 'MIXED_ARTIFACTS',
      message:
        `.next 同时含有生产构建的 BUILD_ID 与 dev 的 static/development —— ` +
        `两套 chunk 命名规则不同，混用会让 main-app.js / polyfills.js / layout.css 404，` +
        `页面有数据却不渲染。${CLEAN_HINT}`,
    });
  }

  if (fp.hasAppBuildManifest && !fp.hasDevStatic && !fp.hasBuildId) {
    issues.push({
      code: 'DANGLING_MANIFEST',
      message:
        `.next/app-build-manifest.json 存在，但既没有 BUILD_ID 也没有 static/development —— ` +
        `清单位于一次被中断的写入中间态，客户端会按清单请求不存在的 chunk。${CLEAN_HINT}`,
    });
  }

  if (fp.hasServerDir === true && !fp.hasBuildId && !fp.hasDevStatic) {
    issues.push({
      code: 'MISSING_BUILD_ID',
      message:
        `.next/server 已生成但没有 BUILD_ID，也没有 dev 产物 —— 上次构建中途失败，` +
        `残留会被下次构建当作缓存复用。${CLEAN_HINT}`,
    });
  }

  return issues;
}

/** 读真实目录得到指纹。目录不存在时全 false（首次构建应当放行）。 */
export function readFingerprint(nextDir: string): ArtifactFingerprint {
  return {
    hasBuildId: existsSync(join(nextDir, 'BUILD_ID')),
    hasDevStatic: existsSync(join(nextDir, 'static', 'development')),
    hasAppBuildManifest: existsSync(join(nextDir, 'app-build-manifest.json')),
    hasServerDir: existsSync(join(nextDir, 'server')),
  };
}

/**
 * `prebuild` 的完整前置条件：**产物一致 + 没有 dev 在写**。
 *
 * 只查产物是不够的。dev 正在跑的时候 `.next` 恰好是**纯 dev 态**（没有
 * `BUILD_ID`），指纹检查会放行；但 `next build` 一旦开始写，两套 chunk 命名
 * 就混在同一个目录里 —— 这正是 2026-11-09 事故的成因。所以构建前必须
 * 额外确认「没有 next 在写」。
 *
 * 反过来也一样：产物已经脏了，即使此刻没有进程在跑，也不该继续构建
 * （会把脏状态当成缓存复用）。
 */
export function judgeBuildPrecondition(
  fingerprint: ArtifactFingerprint,
  procs: readonly NodeProcess[] | null,
): readonly (ArtifactIssue | PreconditionIssue)[] {
  return [...detectMixedArtifacts(fingerprint), ...judgeNoNextRunning(procs)];
}

function main(): void {
  const nextDir = join(SRC_ROOT, '.next');
  const fingerprint = readFingerprint(nextDir);
  // `--no-process-check`：只做产物检查（用于单元/静态场景）。
  // 默认查进程 —— `prebuild` 要的就是「构建前 dev 已停」。
  const procs = process.argv.includes('--no-process-check') ? [] : listNodeProcesses();
  const issues = judgeBuildPrecondition(fingerprint, procs);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ nextDir, fingerprint, issues }, null, 2));
  } else if (issues.length === 0) {
    console.log(`[next-artifacts] 通过：${nextDir} 产物状态一致，且没有 next 进程在写`);
  } else {
    console.error(`[next-artifacts] 拦截：${String(issues.length)} 项问题`);
    for (const issue of issues) console.error(`  · ${issue.code} — ${issue.message}`);
  }

  if (issues.length > 0) process.exitCode = 1;
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('scripts/check-next-artifacts.ts') ||
    process.argv[1].endsWith('scripts\\check-next-artifacts.ts'));

if (isMain) main();
