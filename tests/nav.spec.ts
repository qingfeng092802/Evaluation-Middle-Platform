/**
 * 导航结构与路由高亮（`[FE-01]` DoD：「布局无第 5 个导航分区」）。
 *
 * 这条 DoD 无法靠截图验收——「多了一个分区」在长页面里一点也不显眼。
 * 把结构抽成数据后，分区个数、顺序、以及「P1 项必须是置灰而不是死链」
 * 都能被机器钉死。
 */
import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, resolveActiveNav } from '../lib/ui/nav.js';

describe('NAV_SECTIONS · 只允许 4 个分区（pages-and-flows §0.3）', () => {
  it('恰好 4 个分区', () => {
    expect(NAV_SECTIONS).toHaveLength(4);
  });

  it('分区顺序固定：运行 / 资产 / 算子 / 管理', () => {
    expect(NAV_SECTIONS.map((s) => s.title)).toEqual(['运行', '资产', '算子', '管理']);
  });

  it('M1 可点的页面只有 4 个：/runs、/runs/new、/datasets、/targets', () => {
    const enabled = NAV_SECTIONS.flatMap((s) => s.items)
      .filter((i) => i.disabled !== true)
      .map((i) => i.href);
    expect(enabled).toEqual(['/runs', '/runs/new', '/datasets', '/targets']);
  });

  it('P1 项一律置灰并带 P1 标记（不得是死链）', () => {
    const p1 = NAV_SECTIONS.flatMap((s) => s.items).filter((i) => i.disabled === true);
    expect(p1.map((i) => i.href)).toEqual(['/evaluators', '/settings']);
    for (const item of p1) expect(item.badge).toBe('P1');
  });

  it('每个分区至少有一项（空分区在侧栏里只是一个孤立标题）', () => {
    for (const s of NAV_SECTIONS) expect(s.items.length).toBeGreaterThan(0);
  });
});

describe('resolveActiveNav · 详情页高亮父项', () => {
  it('/runs/[id] 归到 /runs', () => {
    expect(resolveActiveNav('/runs/abc-123')).toBe('/runs');
  });

  it('/runs/new 自己独占（否则「发起评测」永远不亮）', () => {
    expect(resolveActiveNav('/runs/new')).toBe('/runs/new');
  });

  it('资产两页各自高亮', () => {
    expect(resolveActiveNav('/datasets')).toBe('/datasets');
    expect(resolveActiveNav('/datasets/ds_1')).toBe('/datasets');
    expect(resolveActiveNav('/targets')).toBe('/targets');
  });

  it('未知路由不高亮任何项', () => {
    expect(resolveActiveNav('/settings')).toBeUndefined();
    expect(resolveActiveNav(null)).toBeUndefined();
  });
});
