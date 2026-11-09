'use client';

import * as React from 'react';
import { Moon, Sun } from 'lucide-react';
import { resolveInitialTheme, THEME_STORAGE_KEY, toggleTheme, type Theme } from '@/lib/ui/theme';

/**
 * 主题切换（`[FE-01]` 交付物 7）。
 *
 * 首帧真相在 `lib/ui/theme.ts` 的内联脚本里（避免深色用户看到白帧），
 * 这里只负责「读当前 class → 翻转 → 落 storage」。不引入 `next-themes`：
 * 一个布尔值不值得多一个依赖，而多一个依赖就多一套它自己的行为约定。
 */
export function ThemeToggle(): React.ReactElement {
  const [theme, setTheme] = React.useState<Theme>('light');

  React.useEffect(() => {
    try {
      setTheme(resolveInitialTheme(window.localStorage.getItem(THEME_STORAGE_KEY)));
    } catch {
      setTheme('light');
    }
  }, []);

  function onClick(): void {
    const next = toggleTheme(theme);
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 隐私模式下写不进去：本次会话仍然生效，只是刷新后回落到默认浅色。
    }
  }

  const label = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 min-h-tap min-w-tap items-center justify-center rounded-sm text-muted-foreground transition-colors duration-[120ms] hover:bg-muted hover:text-foreground"
    >
      {theme === 'dark' ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
