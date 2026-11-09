/**
 * 主题首帧判断（`[FE-01]` 交付物 7）。
 *
 * 为什么值得单测：`resolveInitialTheme` 决定 SSR/CSR 首帧是否一致。
 * 如果它读 `prefers-color-scheme`，服务端拿不到这个值，水合必然报错；
 * 如果它读 `localStorage` 直接抛，深色用户会看到一帧白屏。
 * 两种错法都能正常「跑起来」，只有断言能拦住。
 */
import { describe, expect, it } from 'vitest';
import { resolveInitialTheme, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY, toggleTheme } from '../lib/ui/theme.js';

describe('resolveInitialTheme · 浅色为主', () => {
  it('无存储值时默认浅色（不跟随系统，避免验收基准漂移）', () => {
    expect(resolveInitialTheme(null)).toBe('light');
    expect(resolveInitialTheme(undefined)).toBe('light');
    expect(resolveInitialTheme('')).toBe('light');
  });

  it('显式选过深色才深色', () => {
    expect(resolveInitialTheme('dark')).toBe('dark');
    expect(resolveInitialTheme('light')).toBe('light');
  });

  it('脏值回落浅色，不抛错', () => {
    expect(resolveInitialTheme('DARK')).toBe('light');
    expect(resolveInitialTheme('blue')).toBe('light');
  });
});

describe('toggleTheme', () => {
  it('light ⇄ dark 可逆', () => {
    expect(toggleTheme('light')).toBe('dark');
    expect(toggleTheme('dark')).toBe('light');
    expect(toggleTheme(toggleTheme('light'))).toBe('light');
  });
});

describe('THEME_BOOT_SCRIPT · 首帧不闪烁', () => {
  it('脚本里用的是同一个 storage key', () => {
    expect(THEME_BOOT_SCRIPT).toContain(THEME_STORAGE_KEY);
  });

  it('只在 dark 时给 <html> 加 class，默认不动', () => {
    expect(THEME_BOOT_SCRIPT).toContain('classList.add("dark")');
    expect(THEME_BOOT_SCRIPT).not.toContain('classList.remove');
  });

  it('整段包在 try/catch 里：localStorage 在隐私模式会直接抛', () => {
    expect(THEME_BOOT_SCRIPT).toContain('try{');
    expect(THEME_BOOT_SCRIPT).toContain('catch(e){}');
  });
});
