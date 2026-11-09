#!/usr/bin/env tsx
/**
 * 一条命令起全栈（`[INT-01]` 交付物 1）。
 *
 * 顺序是**契约**，不是习惯：
 *   1. `docker compose up -d db` → 等库真的能 `SELECT 1`（不是等容器「Up」）；
 *   2. `migrate` → `seed`：这两个是**一次性任务**，必须串行跑完；
 *   3. 三个**常驻进程**并行：`fixture` → `worker` → `next dev`。
 *
 * 三个容易踩的坑，本文件逐一避开：
 *  - **不经过 shell**：Windows 上把 `&&` / `|` 交给 `spawn` 会直接 `ENOENT`。
 *    所有命令一律 `spawn(execPath, argvArray)`，参数数组原样传递。
 *  - **不依赖 PATH 里的 `tsx`**：统一 `node --import tsx <file.ts>`，
 *    这样 `npm run dev:all` 在没装全局 tsx 的机器上也一样跑。
 *  - **先等库再迁移**：容器 `Up` 与 `pg_isready` 通过之间还有几秒，
 *    这段窗口里跑迁移会报 `ECONNREFUSED` —— 看起来像「迁移脚本写错了」。
 *
 * 本进程是**前台监督进程**：任一常驻进程异常退出 ⇒ 整体退出并返回非零，
 * 避免「web 挂了但 worker 还在偷偷跑」这种半死状态。`Ctrl-C` 收全部子进程。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
/** `src/` 绝对路径（本文件位于 `src/scripts/`）。 */
const SRC_ROOT = join(here, '..');

/** 与 `package.json` 的 `dev` 脚本、`SPEC-M1` §3.1 保持一致。 */
export const DEFAULT_APP_PORT = 3000;
export const DEFAULT_FIXTURE_PORT = 8787;

/** 默认连接串：与 `docker-compose.yml` / `.env.example` 一致。 */
const DEFAULT_DATABASE_URL = 'postgres://eval:eval_local_dev_only@127.0.0.1:5433/eval_platform';

/** 起库等待的上限：本机 PG 冷启动通常 < 10s，给到 60s 足够。 */
const DB_WAIT_TIMEOUT_MS = 60_000;
const DB_WAIT_INTERVAL_MS = 500;

/** 一条待执行的命令。`env` 是**叠加**在 `process.env` 之上的增量。 */
export interface DevCommand {
  readonly name: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

function tsxArgv(scriptPath: string): readonly string[] {
  // `node --import tsx x.ts`：tsx 4 会注册 ESM loader 并转译 TS。
  return [process.execPath, '--import', 'tsx', scriptPath];
}

/**
 * 一次性任务：迁移 → 种子。
 *
 * 为什么种子也放进来：SPEC 的 DoD 明确「干净数据库上从零跑通」，
 * 而 `seed` 本身幂等（`seed.spec.ts` 锁了这一点），重复起不会造成脏数据。
 */
export function taskCommands(cwd: string = SRC_ROOT): readonly DevCommand[] {
  return [
    {
      name: 'migrate',
      argv: tsxArgv(join(cwd, 'scripts', 'migrate.ts')),
      env: {},
      cwd,
    },
    {
      name: 'seed',
      argv: tsxArgv(join(cwd, 'scripts', 'seed.ts')),
      env: {},
      cwd,
    },
  ];
}

/**
 * 常驻进程：fixture → worker → next。
 *
 * `FIXTURE_BASE_URL` 显式传给 worker：worker 读的是环境变量，
 * 若只在 fixture 侧改端口，worker 仍会打到默认的 8787 —— 表现为「全部 Case 连接超时」。
 */
export function serviceCommands(
  opts: { readonly appPort: number; readonly fixturePort: number; readonly cwd?: string },
): readonly DevCommand[] {
  const cwd = opts.cwd ?? SRC_ROOT;
  const fixtureBaseUrl = `http://127.0.0.1:${String(opts.fixturePort)}`;

  return [
    {
      name: 'fixture',
      argv: tsxArgv(join(cwd, 'tools', 'fixture-gateway', 'index.ts')),
      env: { FIXTURE_PORT: String(opts.fixturePort) },
      cwd,
    },
    {
      name: 'worker',
      argv: tsxArgv(join(cwd, 'worker', 'index.ts')),
      env: { FIXTURE_BASE_URL: fixtureBaseUrl },
      cwd,
    },
    {
      // next 的 CLI 是**已编译的 JS**，不需要 tsx；直接交给 node 跑同一份 bin。
      name: 'next',
      argv: [
        process.execPath,
        join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
        'dev',
        '-p',
        String(opts.appPort),
      ],
      env: {},
      cwd,
    },
  ];
}

/** 从连接串里取「该等哪个 host:port/db」。缺 port 时回落 pg 的默认 5432。 */
export function dbWaitTarget(url: string): {
  readonly host: string;
  readonly port: number;
  readonly database: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port === '' ? 5432 : Number(u.port),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

function log(name: string, msg: string): void {
  console.log(`[dev:all] ${name} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 跑一个前台子进程，等它退出；非零码抛错。 */
function runOnce(cmd: DevCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.argv[0] ?? 'node', cmd.argv.slice(1), {
      cwd: cmd.cwd,
      env: { ...process.env, ...cmd.env },
      stdio: 'inherit',
      // 关键：不开 shell。开 shell 会让参数被二次解析，Windows 上直接失败。
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd.name} 退出（code=${String(code)}, signal=${String(signal)}）`));
    });
  });
}

/** 拉起 `docker compose up -d db`（可用 `DEV_ALL_SKIP_DOCKER=1` 跳过）。 */
async function ensureDocker(cwd: string): Promise<void> {
  if (process.env['DEV_ALL_SKIP_DOCKER'] === '1') {
    log('docker', '已跳过（DEV_ALL_SKIP_DOCKER=1）');
    return;
  }
  await runOnce({
    name: 'docker',
    argv: ['docker', 'compose', 'up', '-d', 'db'],
    env: {},
    cwd,
  });
}

/** 反复 `SELECT 1` 直到成功或超时。不只看容器状态：`Up` 不等于「能连」。 */
async function waitForDatabase(url: string): Promise<void> {
  const target = dbWaitTarget(url);
  const deadline = Date.now() + DB_WAIT_TIMEOUT_MS;
  let lastError = '';

  log('db', `等待 ${target.host}:${String(target.port)}/${target.database} 可连接 …`);
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      log('db', '就绪');
      return;
    } catch (err) {
      lastError = (err as Error).message;
      await client.end().catch(() => undefined);
      await sleep(DB_WAIT_INTERVAL_MS);
    }
  }
  throw new Error(`数据库在 ${String(DB_WAIT_TIMEOUT_MS / 1000)}s 内未就绪：${lastError}`);
}

const children: ChildProcess[] = [];

function killAll(signal: NodeJS.Signals): void {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === 'win32' && child.pid !== undefined) {
      // Windows 上 `child.kill()` 只杀外壳，不杀它派生出的进程树。
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill(signal);
    }
  }
}

/** 并行拉起常驻进程；任一异常退出即整体失败。返回的 Promise 只在失败时结束。 */
function startServices(cmds: readonly DevCommand[]): Promise<void> {
  return new Promise((_resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    for (const cmd of cmds) {
      const child = spawn(cmd.argv[0] ?? 'node', cmd.argv.slice(1), {
        cwd: cmd.cwd,
        env: { ...process.env, ...cmd.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      children.push(child);

      const pipe = (stream: NodeJS.ReadableStream | null, sink: 'log' | 'error'): void => {
        stream?.on('data', (buf: Buffer) => {
          for (const line of buf.toString('utf8').split(/\r?\n/)) {
            if (line.trim() === '') continue;
            const text = `[${cmd.name}] ${line}`;
            if (sink === 'error') console.error(text);
            else console.log(text);
          }
        });
      };
      pipe(child.stdout, 'log');
      pipe(child.stderr, 'error');

      child.on('error', (err) => fail(new Error(`${cmd.name} 启动失败：${err.message}`)));
      child.on('exit', (code, signal) => {
        if (settled) return;
        // 被我们主动 Ctrl-C 收掉的不算失败
        if (signal === 'SIGTERM' || signal === 'SIGINT') return;
        fail(new Error(`${cmd.name} 意外退出（code=${String(code)}, signal=${String(signal)}）`));
      });
    }

    // 这个 Promise 只在失败时结束，成功路径永远挂住 —— 常驻进程正常运行时不该返回。
  });
}

async function main(): Promise<void> {
  const appPort = Number(process.env['PORT'] ?? DEFAULT_APP_PORT);
  const fixturePort = Number(process.env['FIXTURE_PORT'] ?? DEFAULT_FIXTURE_PORT);
  const url = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;

  // 端口冲突在启动前端之前就发现，比在浏览器里看到白屏好查得多。
  if (appPort === fixturePort) {
    throw new Error(`PORT 与 FIXTURE_PORT 不能相同（都是 ${String(appPort)}）`);
  }

  await ensureDocker(SRC_ROOT);
  await waitForDatabase(url);

  for (const task of taskCommands(SRC_ROOT)) {
    log(task.name, '开始');
    await runOnce(task);
    log(task.name, '完成');
  }

  const services = serviceCommands({ appPort, fixturePort, cwd: SRC_ROOT });
  log('services', `启动 ${services.map((c) => c.name).join(' / ')}`);
  log('app', `http://127.0.0.1:${String(appPort)}`);
  log('fixture', `http://127.0.0.1:${String(fixturePort)}/health`);
  log('hint', 'Ctrl-C 结束全部进程');

  await startServices(services);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('scripts/dev-all.ts') || process.argv[1].endsWith('scripts\\dev-all.ts'));

if (isMain) {
  const shutdown = (signal: NodeJS.Signals): void => {
    log('dev:all', `收到 ${signal}，收全部子进程`);
    killAll(signal);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  main().catch((err: unknown) => {
    console.error('[dev:all] 失败：', err instanceof Error ? err.message : err);
    killAll('SIGTERM');
    process.exit(1);
  });
}
