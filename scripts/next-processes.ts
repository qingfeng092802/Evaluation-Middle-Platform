/**
 * 「有没有 next 在写 `.next`」的**唯一**判定口径（`B-01`/`B-02`）。
 *
 * `clean:next`（删除前）与 `prebuild`（构建前）都需要同一个答案，
 * 所以分类与判定放在这里，两个入口只负责 IO 与退出码 —— 否则两份实现迟早漂移，
 * 而漂移的表现是「一个入口拦、另一个放行」，最难查。
 *
 * ## 为什么不能只用 `CommandLine -match "next"`
 *
 * 第一版就是这么写的，结果 `scripts/clean-next.mjs` **自己**命中
 * （命令行里含 `clean-next`），于是清理脚本永远自我拒绝。这不是理论问题，
 * 是 2026-11-09 实跑时抓到的：
 *
 * ```
 * PID 54404 — D:\node\node.exe scripts/clean-next.mjs
 * ```
 *
 * 所以必须按**真正会写 `.next` 的 next 命令**分类：`next dev|start|build`，
 * 以及 `next start` 派生的 `start-server.js`。
 */
import { execFileSync } from 'node:child_process';

export interface NodeProcess {
  readonly ProcessId: number;
  readonly CommandLine?: string;
}

export interface PreconditionIssue {
  readonly code: 'NEXT_RUNNING' | 'UNKNOWN';
  readonly message: string;
}

/**
 * 列出所有 node 进程。
 *
 * 拿不到（非 Windows / PowerShell 不可用）时返回 `null` —— 表示「确认不了」，
 * 由 `judgeNoNextRunning` 按「拒绝」处理。**不要**把失败退化成空数组：
 * 那等于把「不知道」当成「没有」，而放行的代价是弄坏一个正在跑的服务。
 */
export function listNodeProcesses(): readonly NodeProcess[] | null {
  if (process.platform !== 'win32') return null;
  try {
    const ps = [
      '$ErrorActionPreference="Stop";',
      'Get-CimInstance Win32_Process |',
      'Where-Object { $_.Name -eq "node.exe" } |',
      'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ].join(' ');
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (raw === '') return [];
    const parsed = JSON.parse(raw) as NodeProcess | NodeProcess[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

/**
 * 这条命令行会不会写 `.next`。
 *
 * 判据是 next 的**入口形态**，不是「含有 next 字样」：
 *  - `<...>/next/dist/bin/next <dev|start|build>`：CLI 本体；
 *  - `<...>/next/dist/server/lib/start-server.js`：`next start` 派生的工作进程，
 *    它才是真正持有 `.next` 的那个。
 *
 * 排除：`scripts/clean-next.mjs`、`scripts/check-next-artifacts.ts`、`dev-all.ts`
 * 等工具脚本 —— 名字里有 next，但只读或只删，不构建。
 */
export function classifyNextCommand(commandLine: string): boolean {
  if (commandLine.trim() === '') return false;
  // 归一化分隔符，Windows 上可能是反斜杠
  const cmd = commandLine.replace(/\\/g, '/');

  // next CLI：.../next/dist/bin/next <subcommand>
  const cli = /\/next\/dist\/bin\/next["']?\s+(dev|start|build)(\s|$)/.exec(cmd);
  if (cli !== null) return true;

  // next start 的服务端工作进程
  if (/\/next\/dist\/server\/lib\/start-server\.js/.test(cmd)) return true;

  return false;
}

/** 从完整进程表里筛出「会写 `.next`」的那些。 */
export function filterNextWriters(procs: readonly NodeProcess[]): readonly NodeProcess[] {
  return procs.filter((p) => classifyNextCommand(p.CommandLine ?? ''));
}

/**
 * 前置条件判定。空数组 = 可以继续。
 *
 * `procs === null` 表示「确认不了」（非 Windows / PowerShell 不可用）。
 * 这类前置条件在不确定时必须拒绝：放行的代价是弄坏一个正在跑的服务，
 * 而症状会伪装成别的问题（资源 404、页面不渲染）。
 */
export function judgeNoNextRunning(
  procs: readonly NodeProcess[] | null,
): readonly PreconditionIssue[] {
  if (procs === null) {
    return [
      {
        code: 'UNKNOWN',
        message:
          '无法确认是否有 next 进程在运行（进程枚举不可用）。' +
          '请先停掉 next dev / next start 再继续；确认后重试。',
      },
    ];
  }

  const writers = filterNextWriters(procs);
  if (writers.length === 0) return [];

  const list = writers
    .map((p) => `PID ${String(p.ProcessId)} — ${String(p.CommandLine ?? '').slice(0, 120)}`)
    .join('；');
  return [
    {
      code: 'NEXT_RUNNING',
      message:
        `还有 ${String(writers.length)} 个 next 进程在运行（${list}）。` +
        '它们会写 .next：dev 与 build 的 chunk 命名规则不同，混在一起会让客户端资源 404、' +
        '页面不水合（表现为「接口有数据但表格是空的」）。请先停掉它们再继续。',
    },
  ];
}
