/**
 * Worker 进程入口。
 *
 * 只做三件事：装信号处理、启动主循环、把未捕获异常记下来后退出。
 * 业务逻辑一律在 `worker/loop.ts` 与 `lib/runner`，保证本文件可以在测试里被跳过。
 */
import { installSignalHandlers, runWorker } from './loop.js';

installSignalHandlers();

runWorker().catch((err: unknown) => {
  console.error('[worker] 致命错误：', err);
  process.exitCode = 1;
});
