/**
 * 本机 Chromium/Edge 的加载器（`scripts/` 与 `tests/` 共用）。
 *
 * 项目**不新增 `playwright` devDependency**：浏览器交互只在验收/回归时需要，
 * 为它在 `package.json` 里拖一个 400MB 的包、还要求在构建期下载浏览器二进制，
 * 与「构建期不联网」的硬约束直接冲突（`docs/工程规则.md` §9）。
 *
 * 因此这里加载 **npx 缓存里已存在的 `playwright-core`** + **本机已装的 Edge**。
 * 同一份逻辑原先在 `pg-interaction-check.ts` / `check-datasets-render.ts` 各抄了一遍，
 * 现在收敛到这里，避免第三份、第四份副本漂移。
 *
 * `tryLocalChromium()` 在以下两种情况下返回 `null` 而不是抛错 —— 调用方据此**跳过**
 * 而不是**失败**，并且必须打印原因（跳过 ≠ 通过）：
 *  - npx 缓存里没有 `playwright-core`；
 *  - 本机没有 Edge。
 */
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 与 `scripts/pg-interaction-check.ts` 完全一致的本机浏览器路径。 */
export const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/**
 * npx 缓存里的 `playwright-core`（1.65.0）。
 *
 * 钉在缓存路径上是有意的：版本随 npx 一起变，项目不必跟着升级。
 * 需要换机时改这一处即可（或设 `PW_CORE_PATH`）。
 */
const PW_CORE_PATH =
  process.env['PW_CORE_PATH'] ??
  resolve(
    'C:/Users/15539/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.js',
  );

/** `locator()` 返回的句柄。`first()` / `nth()` 仍可继续 `.locator()` 链式下钻。 */
export interface PwLocator {
  locator: (sel: string, opts?: { hasText?: string }) => PwLocator;
  first: () => PwLocator;
  nth: (index: number) => PwLocator;
  focus: () => Promise<void>;
  click: () => Promise<void>;
  count: () => Promise<number>;
  isVisible: () => Promise<boolean>;
  waitFor: (opts: { state: string; timeout?: number }) => Promise<void>;
  /** 对该元素求值（用于读它自己的文案）。允许传字符串，理由同 `PwPage.evaluate`。 */
  evaluate: <T>(fn: ((el: Element) => T) | string) => Promise<T>;
}

/** 只声明本仓库真正用到的少量 API，避免为 `playwright-core` 引入类型依赖。 */
export interface PwPage {
  goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
  reload: (opts?: { waitUntil?: string }) => Promise<unknown>;
  close: () => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  $: (sel: string) => Promise<{ boundingBox: () => Promise<{ width: number; height: number } | null> } | null>;
  $eval: <T>(sel: string, fn: (n: Element) => T) => Promise<T>;
  $$eval: <T>(sel: string, fn: (els: Element[]) => T) => Promise<T>;
  /**
   * 浏览器求值。
   *
   * 允许传**字符串**是有意的：tsx（esbuild `keepNames`）会给具名函数插入
   * `__name(...)`，而浏览器上下文没有这个 helper，函数形式会报
   * `__name is not defined`。字符串形式绕过编译期包装。
   */
  evaluate: <T>(fn: (() => T) | string) => Promise<T>;
  locator: (sel: string, opts?: { hasText?: string }) => PwLocator;
  keyboard: { press: (k: string) => Promise<void> };
  on: (ev: string, cb: (arg: never) => void) => void;
}

export interface PwBrowser {
  newPage: (opts: { viewport: { width: number; height: number } }) => Promise<PwPage>;
  close: () => Promise<void>;
}

export interface ChromiumLauncher {
  launch: (opts: { executablePath: string }) => Promise<PwBrowser>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 拿到 chromium 启动器；本机条件不满足时返回 `null`。
 *
 * 返回 `null` 的两种情况都会写 `console.warn`：静默跳过会让「合并前必须真机跑一遍」
 * 这条约定失效 —— 那是 `B-02` 事故的同型风险。
 */
export async function tryLocalChromium(): Promise<ChromiumLauncher | null> {
  if (!(await exists(PW_CORE_PATH))) {
    console.warn(`[pw-local] 未找到 playwright-core：${PW_CORE_PATH}（浏览器检查跳过）`);
    return null;
  }
  if (!(await exists(EDGE_PATH))) {
    console.warn(`[pw-local] 未找到本机 Edge：${EDGE_PATH}（浏览器检查跳过）`);
    return null;
  }

  const mod = (await import(pathToFileURL(PW_CORE_PATH).href)) as {
    default?: { chromium?: ChromiumLauncher };
    chromium?: ChromiumLauncher;
  };
  // playwright-core 的 ESM 命名空间把 API 挂在 `default` 上；两种形状都兜住。
  const chromium = (mod.default ?? mod).chromium;
  if (chromium === undefined) {
    console.warn('[pw-local] playwright-core 未导出 chromium（浏览器检查跳过）');
    return null;
  }
  return chromium;
}
