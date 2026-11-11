#!/usr/bin/env tsx
/**
 * 删除 `.next`（`B-01`/`B-02` 的处理动作）。
 *
 * ## 为什么不直接 `rm -rf .next`
 *
 * 在活着的 `next dev` 底下删 `.next` 会把正在跑的 dev 一起弄坏，而坏法很隐蔽：
 * dev 进程不退出，继续按内存里的旧清单提供资源，删掉的文件变成 404 —— 与
 * 「混合产物」的症状一模一样，排查时会被误判成上次的问题没修好。
 *
 * 所以这个脚本**先确认没有 next 进程在写**，确认不了就拒绝执行。
 * `--force` 只给「我确定」的场合用。
 *
 * 分类与枚举口径见 `scripts/next-processes.ts`（与 `prebuild` 共用同一份）。
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeNoNextRunning, listNodeProcesses } from './next-processes.js';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT_DIR = join(SRC_ROOT, '.next');
const force = process.argv.includes('--force');

function main(): void {
  if (!existsSync(NEXT_DIR)) {
    console.log('[clean:next] .next 不存在，无需清理');
    return;
  }

  const procs = listNodeProcesses();
  const issues = judgeNoNextRunning(procs);

  if (issues.length > 0) {
    if (procs === null && force) {
      console.log('[clean:next] 无法确认进程状态，按 --force 继续');
    } else {
      for (const issue of issues) console.error(`[clean:next] ${issue.message}`);
      process.exitCode = 1;
      return;
    }
  }

  rmSync(NEXT_DIR, { recursive: true, force: true });
  console.log(`[clean:next] 已删除 ${NEXT_DIR}`);
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('scripts/clean-next.ts') ||
    process.argv[1].endsWith('scripts\\clean-next.ts'));

if (isMain) main();
