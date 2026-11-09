/**
 * 主题（`[FE-01]` 交付物 7：浅色为主，深色兼容）。
 *
 * 事实约束：
 * - `DESIGN.md` §2.4 的深色 Token 是**单独选定**的一组值，不是浅色的自动反转；
 * - 所以「深色」只能通过 `html.dark` 切到那张表，组件里不允许任何 `dark:` 硬编码颜色。
 *
 * 纯函数放这里而不是组件里：SSR 首次渲染拿不到 `localStorage`，
 * 「首帧该渲染成什么」必须是一个能被单测钉死的判断，否则必然出现水合不一致。
 */

export const THEME_STORAGE_KEY = 'eval-platform-theme';

export type Theme = 'light' | 'dark';

/**
 * 首帧主题。
 *
 * 默认**浅色**（需求方拍板「浅色为主」）：`prefers-color-scheme: dark` 不参与决策，
 * 否则用户的操作系统设置会越过产品默认值，截图与验收基准随之漂移。
 * 只有用户显式选过深色才切深色。
 */
export function resolveInitialTheme(stored: string | null | undefined): Theme {
  return stored === 'dark' ? 'dark' : 'light';
}

/** 点击切换：light ⇄ dark。 */
export function toggleTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

/**
 * 在 `<html>` 上落地的脚本源码（内联执行，避免闪烁）。
 *
 * 用内联脚本而不是 `useEffect`：后者要等 hydration 完，深色用户会先看到一帧白屏。
 */
export const THEME_BOOT_SCRIPT =
  `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  `if(t==="dark"){document.documentElement.classList.add("dark");}}catch(e){}})();`;
