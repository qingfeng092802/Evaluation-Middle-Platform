/**
 * `npm run dev:all` 的启动编排自测（`[INT-01]` 交付物 1）。
 *
 * 为什么值得写测试：这个脚本唯一的用处就是「一条命令起全栈」，
 * 而它的失败形态极难自查 —— 少起 fixture，评测全 FAILED 看起来像算子 bug；
 * 少跑 seed，页面空状态看起来像接口 bug；顺序反了（worker 先于 migrate），
 * 报错是「relation does not exist」，与「迁移写错了」长得一模一样。
 *
 * 这里不断言「进程真的起来了」（那要靠 Step 3 的端到端自检），
 * 只死死钉住三件事：**步骤顺序**、**参数形状**、**不经过 shell**。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_PORT,
  DEFAULT_FIXTURE_PORT,
  dbWaitTarget,
  serviceCommands,
  taskCommands,
} from '../scripts/dev-all.js';

/** 把 argv 拼成一行便于做「含某段」断言（不做 shell 转义，只为可读）。 */
function flat(argv: readonly string[]): string {
  return argv.join(' ');
}

describe('taskCommands · 迁移与种子必须先于任何服务启动', () => {
  it('顺序固定为 migrate → seed', () => {
    expect(taskCommands().map((c) => c.name)).toEqual(['migrate', 'seed']);
  });

  it('每个任务都用当前 node + `--import tsx` 执行，不依赖 PATH 里的 tsx', () => {
    for (const c of taskCommands()) {
      expect(c.argv[0]).toBe(process.execPath);
      expect(c.argv.slice(1, 3)).toEqual(['--import', 'tsx']);
      // 脚本路径必须落在 scripts/ 下（用正斜杠与反斜杠两种形式都接受）
      expect(flat(c.argv)).toMatch(/scripts[\\/](migrate|seed)\.ts$/);
    }
  });
});

describe('serviceCommands · 常驻进程', () => {
  it('顺序为 fixture → worker → next', () => {
    const cmds = serviceCommands({ appPort: 3000, fixturePort: 8787 });
    expect(cmds.map((c) => c.name)).toEqual(['fixture', 'worker', 'next']);
  });

  it('next 走 `next dev -p <port>`，端口来自入参', () => {
    const [next] = serviceCommands({ appPort: 3101, fixturePort: 8787 }).filter(
      (c) => c.name === 'next',
    );
    expect(next).toBeDefined();
    const argv = next?.argv ?? [];
    expect(argv[0]).toBe(process.execPath);
    expect(flat(argv)).toContain('next');
    expect(argv.slice(-3)).toEqual(['dev', '-p', '3101']);
  });

  it('worker 拿到与 fixture 一致的回环 base URL', () => {
    const cmds = serviceCommands({ appPort: 3000, fixturePort: 9911 });
    const fixture = cmds.find((c) => c.name === 'fixture');
    const worker = cmds.find((c) => c.name === 'worker');
    expect(fixture?.env['FIXTURE_PORT']).toBe('9911');
    expect(worker?.env['FIXTURE_BASE_URL']).toBe('http://127.0.0.1:9911');
    // 只绑回环：9099 这类「监听全网卡」的写法必须不出现
    expect(worker?.env['FIXTURE_BASE_URL']).not.toContain('0.0.0.0');
  });

  it('worker 与 next 各自带 `--import tsx` / next bin，均不经过 shell', () => {
    for (const c of serviceCommands({ appPort: 3000, fixturePort: 8787 })) {
      if (c.name === 'next') continue; // next 是已编译的 JS，不需要 tsx
      expect(c.argv.slice(1, 3)).toEqual(['--import', 'tsx']);
    }
    // 任何一步都不许拼 shell 语法：Windows 上 `&&`/`|` 会让 spawn 直接报 ENOENT
    for (const c of [...taskCommands(), ...serviceCommands({ appPort: 3000, fixturePort: 8787 })]) {
      expect(flat(c.argv)).not.toMatch(/&&|\|\||;|\|/);
    }
  });
});

describe('默认值与数据库等待目标', () => {
  it('默认端口与 SPEC 一致（3000 / 8787）', () => {
    expect(DEFAULT_APP_PORT).toBe(3000);
    expect(DEFAULT_FIXTURE_PORT).toBe(8787);
  });

  it('等待的库是 docker-compose 暴露的 5433，而不是本机 5432', () => {
    const t = dbWaitTarget('postgres://eval:secret@127.0.0.1:5433/eval_platform');
    expect(t.host).toBe('127.0.0.1');
    expect(t.port).toBe(5433);
    expect(t.database).toBe('eval_platform');
  });

  it('连接串缺 port 时回落到 5432（pg 的默认值）', () => {
    expect(dbWaitTarget('postgres://eval:secret@127.0.0.1/eval_platform').port).toBe(5432);
  });
});
