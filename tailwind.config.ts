import type { Config } from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';

/**
 * Tailwind **v3.4** 配置（`DESIGN.md` §2.8 的实现载体）。
 *
 * 唯一允许写颜色的地方是 `hsl(var(--…))`：真实数值全部在 `app/globals.css` 的 `:root` / `.dark`。
 * 两者必须逐值一致；冲突时以 `DESIGN.md` 为准并回头修这里。
 *
 * 注意 `content` 同时包含 `app/`、`components/`、`lib/`：
 * `lib/` 里也有类名（如状态徽章的 tone → class 映射），漏了它 Tailwind 会静默删除那些类。
 */
export default {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        body: 'hsl(var(--body-foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--eval-fail-fg))',
          foreground: 'hsl(var(--card))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        eval: {
          pass: {
            DEFAULT: 'hsl(var(--eval-pass-fg))',
            bg: 'hsl(var(--eval-pass-bg))',
            mark: 'hsl(var(--eval-pass-mark))',
          },
          fail: {
            DEFAULT: 'hsl(var(--eval-fail-fg))',
            bg: 'hsl(var(--eval-fail-bg))',
            mark: 'hsl(var(--eval-fail-mark))',
          },
          warn: {
            DEFAULT: 'hsl(var(--eval-warn-fg))',
            bg: 'hsl(var(--eval-warn-bg))',
            mark: 'hsl(var(--eval-warn-mark))',
          },
          running: {
            DEFAULT: 'hsl(var(--eval-running-fg))',
            bg: 'hsl(var(--eval-running-bg))',
            mark: 'hsl(var(--eval-running-mark))',
          },
        },
        diff: {
          del: { bg: 'hsl(var(--diff-del-bg))', fg: 'hsl(var(--diff-del-fg))' },
          add: { bg: 'hsl(var(--diff-add-bg))', fg: 'hsl(var(--diff-add-fg))' },
        },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
          baseline: 'hsl(var(--chart-baseline))',
          grid: 'hsl(var(--chart-grid))',
          axis: 'hsl(var(--chart-axis))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: { overlay: 'var(--shadow-overlay)' },
      fontSize: {
        '2xs': ['11px', '16px'],
        xs: ['12px', '18px'],
        sm: ['13px', '20px'],
        base: ['14px', '22px'],
      },
      fontFamily: {
        // 字体栈顺序与 `DESIGN.md` §3.1 逐字一致；`Inter` 由 @fontsource 本地打包
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'Fira Code', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      spacing: {
        // 布局骨架的四个硬尺寸（`DESIGN.md` §1.2），写成 Token 防止各处魔法数
        sidebar: '220px',
        'sidebar-collapsed': '56px',
        topbar: '48px',
        'row-h': '36px',
        'thead-h': '32px',
      },
      minWidth: {
        'tap': '24px',
      },
      minHeight: {
        'tap': '24px',
      },
      keyframes: {
        'eval-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.82)' },
        },
      },
      animation: {
        'eval-pulse': 'eval-pulse 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      transitionTimingFunction: {
        // Sheet 滑入用（`DESIGN.md` §6.2）
        sheet: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
