/**
 * vitest globalSetup：把「真实浏览器对账」需要的活服务拉起来（需求方 2026-11-18
 * 指令：不允许静默 skipped——跳过 ≠ 通过）。
 *
 * 背景：compare-page / runs-render-parity / datasets-render-parity / pg04-drawer /
 * run-detail-keyboard 五个文件的 `describe.skipIf(LIVE_ITEMS === null || LAUNCHER === null)`
 * 探测 `http://127.0.0.1:3000`。dev server 没起时它们**整段跳过**（会打印原因，
 * 但在 CI/钩子环境里等于永远不跑）。
 *
 * 语义（三态，必须分清）：
 *  1. **外部已在跑**（用户自己起的 dev:all）⇒ 直接复用，teardown **不杀**——
 *     不是本进程拉起的就不归本进程处置；
 *  2. **未起** ⇒ 本 setup 用 `npm run dev:all` 拉起（detached 子进程），
 *     就绪轮询通过后测试才开跑；teardown 用 `taskkill /T /F` 杀整棵进程树
 *     （Windows 下 spawn 树不杀会留下孤儿 next dev——M1 的 U-1 教训）；
 *  3. **拉起失败** ⇒ 抛错让全量测试直接失败，而不是回退成静默 skipped。
 *
 * 数据前提（5 个文件的 LIVE_ITEMS / FIXTURE / HAS_RUN_ROWS 条件）：dev 库
 * `eval_platform` 需要有评测集与 ≥2 条 Case 的 run——`dev:all` 的 seed 与
 * 历史真栈自检数据已满足；本 setup 只负责「服务可达」，不造数据。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3000';
const READY_TIMEOUT_MS = 150_000;
const READY_INTERVAL_MS = 2_000;

let spawned: ChildProcess | null = null;

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/runs?limit=1`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function killTree(pid: number): void {
  try {
    // detached 子进程自成进程组，`/T` 连子进程（next dev、worker、fixture）一起收
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // 杀不掉就留着——诊断信息里已写明日志路径
  }
}

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (await healthy()) {
    console.log('[global-setup] 127.0.0.1:3000 已有活服务（外部启动），复用且 teardown 不杀');
    return;
  }

  console.log('[global-setup] 127.0.0.1:3000 不可达，拉起 npm run dev:all …');
  const logPath = join(tmpdir(), 'eval-dev-all.log');
  const out = openSync(logPath, 'a');
  spawned = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:all'], {
    cwd: process.cwd(),
    detached: true,
    // Windows ≥20.12：.cmd shim 无 shell spawn 直接 EINVAL（CVE-2024-27980 修复）；
    // shell:true 下树根是 shell 进程，taskkill /T 仍能整树收掉
    shell: process.platform === 'win32',
    stdio: ['ignore', out, out],
  });
  spawned.on('error', (err) => {
    console.error(`[global-setup] dev:all spawn 失败：${String(err)}（日志：${logPath}）`);
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(spawned?.exitCode === null && spawned?.killed === false && spawned.pid !== undefined)) {
      // 进程已退出（监督进程任一常驻项挂掉会整体退出）
      throw new Error(`[global-setup] dev:all 提前退出（exitCode=${String(spawned?.exitCode)}），日志：${logPath}`);
    }
    if (await healthy()) {
      console.log(`[global-setup] dev server 就绪（PID ${String(spawned.pid)}，日志：${logPath}）`);
      return async () => {
        if (spawned?.pid !== undefined) {
          console.log(`[global-setup] teardown：taskkill /T /F PID ${String(spawned.pid)}`);
          killTree(spawned.pid);
        }
      };
    }
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  killTree(spawned.pid ?? 0);
  throw new Error(`[global-setup] dev server ${String(READY_TIMEOUT_MS / 1000)}s 内未就绪，日志：${logPath}`);
}
