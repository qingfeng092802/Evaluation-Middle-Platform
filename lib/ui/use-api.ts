'use client';

import * as React from 'react';
import type { z } from 'zod';
import { ApiClientError, apiGet } from './client';

/**
 * 只读数据获取钩子（`[FE-02]` / `[FE-03]` 的唯一数据入口）。
 *
 * 三态齐全（`AS-3`）且**区分「首次加载」与「刷新」**：
 *  - `loading` 只在**还没有任何数据**时为真 ⇒ 骨架；
 *  - `refreshing` 在已有数据、正在取新一帧时为真 ⇒ 保留上一帧 + 降透明度。
 * 直接把两者合并成一个布尔值，刷新时就会闪骨架 —— 那是 `DESIGN.md` §6 明令禁止的。
 *
 * 刻意不做「自动重试」：请求失败时把 `ApiClientError.code` 交给页面，
 * 由页面决定展示「去配置」还是「重试」。静默重试会让用户盯着一个空页面等。
 */
export interface ApiState<T> {
  readonly data: T | null;
  readonly error: ApiClientError | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly reload: () => void;
}

/** `path` 为 `null` 时**不发请求**（依赖尚未满足，例如还没选评测集版本）。 */
export function useApi<T extends z.ZodTypeAny>(
  schema: T,
  path: string | null,
): ApiState<z.output<T>> {
  const [data, setData] = React.useState<z.output<T> | null>(null);
  const [error, setError] = React.useState<ApiClientError | null>(null);
  const [busy, setBusy] = React.useState<boolean>(path !== null);
  const [tick, setTick] = React.useState(0);

  // schema 是模块级常量（Zod 对象引用稳定），但调用方可能传字面量；
  // 用 tick 作为副依赖，避免把 schema 放进 deps 导致无限循环。
  React.useEffect(() => {
    if (path === null) {
      setBusy(false);
      return;
    }
    let alive = true;
    setBusy(true);

    apiGet(schema, path)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(
          e instanceof ApiClientError
            ? e
            : new ApiClientError({
                code: 'INTERNAL_ERROR',
                message: '未知错误',
                status: 0,
                requestId: '',
              }),
        );
      })
      .finally(() => {
        if (alive) setBusy(false);
      });

    return () => {
      alive = false;
    };
    // 依赖只有 `path` 与 `tick`：`schema` 是模块级 Zod 常量（引用稳定），
    // 放进 deps 会让调用方传字面量的场景无限重取。
    // 本仓库未安装 `eslint-plugin-react-hooks`，故此处不写 `eslint-disable` 注释
    // ——那条注释本身会因为「规则不存在」而报错。
  }, [path, tick]);

  const reload = React.useCallback(() => setTick((t) => t + 1), []);

  return {
    data,
    error,
    loading: busy && data === null,
    refreshing: busy && data !== null,
    reload,
  };
}

/**
 * 每 `intervalMs` 触发一次 `onTick`，`enabled` 为 false 时完全停止。
 *
 * 抽出来的原因：`[FE-03]` 要求「进入终态即停」「`document.hidden` 时暂停，
 * 恢复可见立即拉一次」。这三条用 `setInterval` + 三个 `if` 写在一起很容易漏掉清理，
 * 而漏掉的表现是「页面关掉后还在后台打接口」——不报错、很难发现。
 */
export function usePolling(
  onTick: () => void,
  enabled: boolean,
  intervalMs: number,
): void {
  // 用 ref 持有最新回调：否则每次 render 换了函数引用都会重建 interval，
  // 轮询间隔会被 render 频率带偏。
  const cb = React.useRef(onTick);
  React.useEffect(() => {
    cb.current = onTick;
  }, [onTick]);

  React.useEffect(() => {
    if (!enabled) return;

    const timer = window.setInterval(() => cb.current(), intervalMs);

    // 恢复可见时立即拉一次：否则用户切回来最多要等一整个 interval 才看到新数据。
    const onVisible = (): void => {
      if (!document.hidden) cb.current();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs]);
}
