/**
 * 主导航结构（`pages-and-flows.md` §0.3）。
 *
 * 放在 `lib/` 而不是直接写进 `app-shell.tsx`，是为了让「只有 4 个分区」
 * 这条**硬约束**能被单测断言。写死在 JSX 里就只能靠人眼数分区个数，
 * 而「多加一个分区」恰恰是最容易在后续里程碑里悄悄发生的事。
 *
 * 图标只记名字（Lucide 顶层导出名），由组件层查表；`lib/` 不依赖 React。
 */

export type NavIconName =
  | 'Activity'
  | 'Play'
  | 'Database'
  | 'Target'
  | 'ListChecks'
  | 'Settings';

export interface NavItemSpec {
  readonly label: string;
  readonly href: string;
  readonly icon: NavIconName;
  /** P1 功能：置灰并标注，**不做成死链**（点一个 404 比看到置灰项更困惑）。 */
  readonly disabled?: boolean;
  readonly badge?: string;
}

export interface NavSectionSpec {
  readonly title: string;
  readonly items: readonly NavItemSpec[];
}

/**
 * 四个分区，顺序固定：运行 / 资产 / 算子 / 管理。
 *
 * ⚠️ **不得新增第 5 个分区**（`pages-and-flows.md` §0.3 硬约束，
 * `SPEC-M1` `[FE-01]` DoD）。新增页面必须落进已有四个分区之一。
 */
export const NAV_SECTIONS: readonly NavSectionSpec[] = [
  {
    title: '运行',
    items: [
      { label: '评测运行台', href: '/runs', icon: 'Activity' },
      { label: '发起评测', href: '/runs/new', icon: 'Play' },
    ],
  },
  {
    title: '资产',
    items: [
      { label: '评测集', href: '/datasets', icon: 'Database' },
      { label: '待测目标', href: '/targets', icon: 'Target' },
    ],
  },
  {
    title: '算子',
    items: [{ label: '算子库', href: '/evaluators', icon: 'ListChecks', disabled: true, badge: 'P1' }],
  },
  {
    title: '管理',
    items: [{ label: '管理配置', href: '/settings', icon: 'Settings', disabled: true, badge: 'P1' }],
  },
];

/**
 * 路由 → 高亮项。
 *
 * `/runs/[runId]` 归到「评测运行台」：详情页不是独立入口，
 * 若不高亮父项，用户会觉得侧栏「什么都没选中」。
 */
export function resolveActiveNav(pathname: string | null): string | undefined {
  if (pathname === null) return undefined;
  if (pathname === '/runs/new') return '/runs/new';
  if (pathname.startsWith('/runs')) return '/runs';
  if (pathname.startsWith('/datasets')) return '/datasets';
  if (pathname.startsWith('/targets')) return '/targets';
  return undefined;
}
