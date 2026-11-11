/**
 * `cn()` —— 类名合并（shadcn/ui 约定）。
 *
 * `clsx` 负责条件拼接，`twMerge` 负责解决 Tailwind 冲突：
 * 没有 `twMerge` 时，`"px-4 px-6"` 两个类都在，最终谁生效取决于 CSS 生成顺序而不是书写顺序，
 * 组件覆写样式会**时灵时不灵**。这是 shadcn/ui 生态里最容易踩的坑。
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
