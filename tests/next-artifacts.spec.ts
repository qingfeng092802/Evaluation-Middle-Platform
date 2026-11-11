/**
 * `B-01`/`B-02` 回归门禁：**禁止混合的 `.next` 产物**。
 *
 * ## 复盘（2026-11-09）
 *
 * 独立验收看到的现象是「`/api/datasets` 有数据，页面却停在空状态」，而页面表格
 * 的渲染路径本身没有缺陷。根因在构建产物：
 *
 * ```
 * .next/BUILD_ID               18:34   ← 一次 next build（生产）
 * .next/app-build-manifest.json 19:14   ← 一个还活着的 next dev 又覆写了它
 * .next/static/development/     19:09   ← dev 的静态产物与生产产物并存
 * ```
 *
 * 生产构建用内容哈希命名 chunk，dev 用固定名（`main-app.js` / `polyfills.js`）。
 * 两套混在同一个 `.next` 里，服务端按 dev 的清单渲染 HTML、按生产的哈希找文件，
 * 结果 `main-app.js` / `polyfills.js` / `layout.css` 全部 404 —— 没有客户端 JS，
 * 也就没有水合，`useApi` 拉回来的数据永远进不了表格。清理 `.next` 后同一份代码
 * 立即恢复（3 条数据 ⇒ 3 行）。
 *
 * ## 为什么用「产物指纹」而不是「查进程」
 *
 * 查「有没有 next dev 在跑」在 Windows 上要解析 WMI，脆且慢；而混合产物一定
 * 会留下可判读的指纹：**生产构建必有 `BUILD_ID`，dev 必有 `static/development/`**。
 * 两者同时存在就是已经被污染了，与进程此刻是否还在跑无关 —— 进程停了，坏产物
 * 还留在盘上，下一次 `next start` 照样白屏。
 *
 * 这里只测纯函数（输入指纹 → 判定），文件系统遍历由 `scripts/check-next-artifacts.ts`
 * 的 IO 包装承担，避免测试依赖真实 `.next` 的当前状态。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectMixedArtifacts,
  judgeBuildPrecondition,
  readFingerprint,
} from '../scripts/check-next-artifacts.js';
import { classifyNextCommand, judgeNoNextRunning } from '../scripts/next-processes.js';

describe('detectMixedArtifacts · 干净产物不得误报', () => {
  it('纯生产构建（有 BUILD_ID、无 dev 目录）⇒ 通过', () => {
    expect(
      detectMixedArtifacts({ hasBuildId: true, hasDevStatic: false, hasAppBuildManifest: true }),
    ).toEqual([]);
  });

  it('纯 dev 产物（无 BUILD_ID、有 dev 目录）⇒ 通过', () => {
    expect(
      detectMixedArtifacts({ hasBuildId: false, hasDevStatic: true, hasAppBuildManifest: true }),
    ).toEqual([]);
  });

  it('.next 不存在（全是 false）⇒ 通过（首次构建不该被拦）', () => {
    expect(
      detectMixedArtifacts({ hasBuildId: false, hasDevStatic: false, hasAppBuildManifest: false }),
    ).toEqual([]);
  });
});

describe('detectMixedArtifacts · 必须拦下混合产物（本次根因）', () => {
  it('BUILD_ID 与 static/development 并存 ⇒ 判为 MIXED', () => {
    const issues = detectMixedArtifacts({
      hasBuildId: true,
      hasDevStatic: true,
      hasAppBuildManifest: true,
    });
    expect(issues.map((i) => i.code)).toContain('MIXED_ARTIFACTS');
  });

  it('判定信息必须点名解决方案（停 dev server 再删 .next），不能只说「不合法」', () => {
    const [issue] = detectMixedArtifacts({
      hasBuildId: true,
      hasDevStatic: true,
      hasAppBuildManifest: true,
    });
    expect(issue?.message).toContain('dev');
    expect(issue?.message).toMatch(/\.next/);
  });

  it('只有 dev 清单、dev 静态目录却不在 ⇒ 判为 DANGLING_MANIFEST', () => {
    const issues = detectMixedArtifacts({
      hasBuildId: false,
      hasDevStatic: false,
      hasAppBuildManifest: true,
    });
    expect(issues.map((i) => i.code)).toContain('DANGLING_MANIFEST');
  });

  it('生产构建缺 BUILD_ID 但已有生产 server 目录 ⇒ 判为 MISSING_BUILD_ID', () => {
    const issues = detectMixedArtifacts({
      hasBuildId: false,
      hasDevStatic: false,
      hasAppBuildManifest: false,
      hasServerDir: true,
    });
    expect(issues.map((i) => i.code)).toContain('MISSING_BUILD_ID');
  });
});

/**
 * `clean:next` 与 `prebuild` 共用的前置条件：**没有 next 进程在写 `.next`**。
 *
 * 两条必须分开的地方：
 *
 *  1. **子串匹配会把工具自己算进去。** 第一版用
 *     `CommandLine -match "next"` 枚举，结果 `scripts/clean-next.mjs` 自己
 *     命中（命令里有 `clean-next`），于是「清理」永远自我拒绝。
 *     必须按**真正会写 `.next` 的 next 命令**分类。
 *  2. **确认不了 ≠ 没有。** 枚举失败（非 Windows / PowerShell 不可用）时
 *     必须拒绝，不能当成「没有进程」放行 —— 放行的代价是弄坏一个正在跑的服务。
 */
describe('classifyNextCommand · 只认真正会写 .next 的命令', () => {
  it('next dev / next start / next build 都是写入者', () => {
    const base = 'D:\\node\\node.exe "D:\\p\\node_modules\\next\\dist\\bin\\next" ';
    expect(classifyNextCommand(`${base}dev -p 3000`)).toBe(true);
    expect(classifyNextCommand(`${base}start -p 3000`)).toBe(true);
    expect(classifyNextCommand(`${base}build`)).toBe(true);
  });

  it('next 的服务端子进程也是写入者（start-server.js）', () => {
    expect(
      classifyNextCommand(
        'D:\\node\\node.exe "D:\\p\\node_modules\\next\\dist\\server\\lib\\start-server.js"',
      ),
    ).toBe(true);
  });

  it('工具脚本自身不算（名字里带 next 但不会写 .next）', () => {
    expect(classifyNextCommand('D:\\node\\node.exe scripts/clean-next.mjs')).toBe(false);
    expect(classifyNextCommand('D:\\node\\node.exe --import tsx scripts/check-next-artifacts.ts')).toBe(
      false,
    );
    expect(classifyNextCommand('D:\\node\\node.exe --import tsx scripts/dev-all.ts')).toBe(false);
  });

  it('与本项目无关的进程不算', () => {
    expect(classifyNextCommand('D:\\node\\node.exe worker/index.ts')).toBe(false);
    expect(classifyNextCommand('')).toBe(false);
  });
});

describe('judgeNoNextRunning · 前置条件', () => {
  it('确认没有 next 进程 ⇒ 放行', () => {
    expect(judgeNoNextRunning([])).toEqual([]);
  });

  it('有 next 进程 ⇒ 拒绝，并点名 PID', () => {
    const issues = judgeNoNextRunning([
      { ProcessId: 1234, CommandLine: 'node .../next/dist/bin/next dev -p 3000' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('1234');
  });

  it('拿不到进程列表（null，表示确认不了）⇒ 拒绝，不能当成「没有」', () => {
    const issues = judgeNoNextRunning(null);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('无法确认');
  });

  it('拒绝信息必须说明为什么（会写出混合产物），不能只说「有进程」', () => {
    const [issue] = judgeNoNextRunning([
      { ProcessId: 1, CommandLine: 'node .../next/dist/bin/next dev' },
    ]);
    expect(issue?.message).toMatch(/\.next/);
  });

  /**
   * `prebuild` 的完整门禁：产物指纹 **和** 进程状态都要过。
   *
   * 单看指纹是不够的：dev 正在跑的时候 `.next` 是**纯 dev 态**（没有 BUILD_ID），
   * 指纹检查会放行；但 `next build` 一写进去就混了。所以构建前必须
   * 额外确认「没有 dev 在写」。这正是用户要求的「构建前停 dev server」。
   */
  it('dev 在跑但 .next 是纯 dev 态 ⇒ 指纹放行、进程拦住', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prebuild-dev-'));
    mkdirSync(join(dir, 'static', 'development'), { recursive: true });
    writeFileSync(join(dir, 'app-build-manifest.json'), '{}', 'utf8');

    expect(detectMixedArtifacts(readFingerprint(dir))).toEqual([]);
    expect(
      judgeBuildPrecondition(readFingerprint(dir), [
        { ProcessId: 999, CommandLine: 'node .../next/dist/bin/next dev -p 3000' },
      ]).map((i) => i.code),
    ).toContain('NEXT_RUNNING');
  });

  it('dev 没在跑、产物也干净 ⇒ 放行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prebuild-ok-'));
    mkdirSync(join(dir, 'static', 'development'), { recursive: true });
    writeFileSync(join(dir, 'app-build-manifest.json'), '{}', 'utf8');
    expect(judgeBuildPrecondition(readFingerprint(dir), [])).toEqual([]);
  });

  it('进程确认不了 ⇒ 构建也拒绝（不确定时不放行）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prebuild-unknown-'));
    expect(judgeBuildPrecondition(readFingerprint(dir), null).map((i) => i.code)).toContain(
      'UNKNOWN',
    );
  });
});
