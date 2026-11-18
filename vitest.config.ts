import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@eval-platform/contracts': fileURLToPath(
        new URL('./contracts/src/index.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // `B-03`/`B-04`：真库测试必须连独立测试库，不能连 dev 库 `eval_platform`
    // （dev:all 的常驻 worker 会在同一个队列上抢 run）。setup 文件在每个测试
    // 进程启动时改写 DATABASE_URL，并在配错时当场抛错。
    setupFiles: ['tests/setup/test-env.ts'],
    // 真实浏览器对账（compare-page / *-render-parity / pg04-drawer /
    // run-detail-keyboard）需要 :3000 活服务——globalSetup 探测/拉起 dev:all，
    // 否则这五个文件会静默 skipped（跳过 ≠ 通过，需求方 2026-11-18 指令）。
    globalSetup: ['tests/global-setup.ts'],
    // 真库测试串行执行：迁移/种子是全局状态，并发会互相踩。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
