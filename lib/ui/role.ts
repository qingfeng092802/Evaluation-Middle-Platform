/**
 * MVP 角色模拟（需求方 2026-11-15 裁定 1，正文见 SPEC-M3 §2 Batch 1「实现前提」）。
 *
 * `X-Role: A|B` 的客户端真相源：`decision` 接口仅 ROLE-B 可调（非 B → 403），
 * 角色在顶栏切换，值由 `lib/ui/client.ts` 统一注入请求头。
 * MVP 不做登录（OUT-4）：状态 = 内存默认值 + localStorage 持久化，
 * 与 `lib/ui/theme.ts` 同一套最小惯例——一个枚举值不值得多一个状态库。
 */
export type PlatformRole = 'A' | 'B';
export const ROLE_STORAGE_KEY = 'eval-platform.role';

let current: PlatformRole = 'A';
let hydrated = false;
const listeners = new Set<() => void>();

export function getRole(): PlatformRole {
  if (!hydrated && typeof window !== 'undefined') {
    try {
      current = window.localStorage.getItem(ROLE_STORAGE_KEY) === 'B' ? 'B' : 'A';
    } catch {
      current = 'A'; // 隐私模式读不到：回落默认
    }
    hydrated = true;
  }
  return current;
}

export function setRole(role: PlatformRole): void {
  current = role;
  hydrated = true;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(ROLE_STORAGE_KEY, role);
    } catch {
      // 隐私模式下写不进去：本次会话仍然生效，只是刷新后回落到默认 A。
    }
  }
  for (const fn of listeners) fn();
}

export function subscribeRole(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
