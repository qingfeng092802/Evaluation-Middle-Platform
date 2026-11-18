/**
 * PG-09 双 Tab（门禁规则 / 基线确认）—— 派生层单测 + 页面静态断言（M4 收尾）。
 *
 * 单测直测 `lib/ui/gates.ts` / `lib/ui/baselines.ts` 的纯函数（同 `m4-ui.spec` 范式）；
 * 静态断言沿用 `settings-providers-ui.spec` 的 readFile 范式：锁「Tab 真的在页面上、
 * 占位真的退场了、没有 mock 顶包」，渲染正确性由浏览器档 `settings-tabs.spec.ts` 负责。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RegressionGateCreate } from '@eval-platform/contracts';
import {
  EMPTY_GATE_DRAFT,
  canManageGates,
  conditionLabel,
  dispatchErrorLabel,
  dispatchStatusLabel,
  draftOfGate,
  gateActiveLabel,
  gateCreateBody,
  gateFormError,
  gateUpdateBody,
  manageGatesDisabledHint,
} from '@/lib/ui/gates';
import {
  baselineStatusLabel,
  baselineRunLabel,
  canDecideBaseline,
  decisionFailureHint,
  decideDisabledHint,
  roleHint,
} from '@/lib/ui/baselines';
import type { RegressionGate } from '@eval-platform/contracts';

// ---------------------------------------------------------------------------
// lib/ui/gates.ts
// ---------------------------------------------------------------------------

describe('gateFormError · 门禁规则表单校验', () => {
  it('规则名空白 → 报错', () => {
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: '   ' })).toContain('规则名');
  });

  it('阈值非数字 → 报错', () => {
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', value: 'abc' })).toContain('数字');
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', value: '' })).toContain('数字');
  });

  it('regression_pct 负阈值 → 报错；0 合法', () => {
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', metric: 'regression_pct', value: '-1' })).toContain('不得为负');
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', metric: 'regression_pct', value: '0' })).toBeNull();
  });

  it('绝对指标越界 → 报错；边界 0/1 合法', () => {
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', metric: 'pass_rate', value: '1.5' })).toContain('[0,1]');
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', metric: 'score_overall', value: '-0.1' })).toContain('[0,1]');
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', metric: 'score_overall', value: '0' })).toBeNull();
    expect(gateFormError({ ...EMPTY_GATE_DRAFT, name: 'L1', metric: 'pass_rate', value: '1' })).toBeNull();
  });
});

describe('gateCreateBody / gateUpdateBody · 请求体形状', () => {
  const draft = { name: ' L1 ', metric: 'score_overall' as const, op: '<' as const, value: '0.85', action: 'BLOCK' as const };

  it('create 体过契约 parse（trim 后入体）', () => {
    const body = gateCreateBody(draft, '00000000-0000-4000-8000-000000000001');
    expect(RegressionGateCreate.parse(body)).toMatchObject({
      name: 'L1',
      datasetId: '00000000-0000-4000-8000-000000000001',
      condition: { metric: 'score_overall', op: '<', value: 0.85 },
      action: 'BLOCK',
    });
  });

  it('update 体只含 name/condition/action 三键（不传即不改，绝不重置 channels/isActive）', () => {
    const body = gateUpdateBody(draft);
    expect(Object.keys(body).sort()).toEqual(['action', 'condition', 'name']);
  });
});

describe('标签函数', () => {
  const gate = {
    condition: { metric: 'score_overall', op: '<', value: 0.85 },
  } as unknown as RegressionGate;

  it('conditionLabel / gateActiveLabel / dispatchStatusLabel', () => {
    expect(conditionLabel(gate.condition)).toBe('score_overall < 0.85');
    expect(gateActiveLabel(true)).toBe('启用');
    expect(gateActiveLabel(false)).toBe('停用');
    expect(dispatchStatusLabel('SUCCESS')).toBe('成功');
    expect(dispatchStatusLabel('FAILED')).toBe('失败');
  });

  it('dispatchErrorLabel：FAILED 带原因（空串兜底「未知原因」），SUCCESS 为 null', () => {
    expect(dispatchErrorLabel({ status: 'FAILED', errorMessage: 'HTTP 500' })).toBe('HTTP 500');
    expect(dispatchErrorLabel({ status: 'FAILED', errorMessage: null })).toBe('未知原因');
    expect(dispatchErrorLabel({ status: 'SUCCESS', errorMessage: null })).toBeNull();
  });

  it('draftOfGate：契约值 → 草稿字符串（编辑预填）', () => {
    const d = draftOfGate({
      name: 'L1',
      condition: { metric: 'regression_pct', op: '>', value: 5 },
      action: 'WARN',
    } as unknown as RegressionGate);
    expect(d).toEqual({ name: 'L1', metric: 'regression_pct', op: '>', value: '5', action: 'WARN' });
  });
});

describe('角色语义（US-017：门禁规则配置仅 ROLE-B）', () => {
  it('canManageGates / manageGatesDisabledHint', () => {
    expect(canManageGates('B')).toBe(true);
    expect(canManageGates('A')).toBe(false);
    expect(manageGatesDisabledHint('B')).toBeNull();
    expect(manageGatesDisabledHint('A')).toContain('ROLE-B');
  });
});

// ---------------------------------------------------------------------------
// lib/ui/baselines.ts
// ---------------------------------------------------------------------------

describe('baselineStatusLabel / baselineRunLabel', () => {
  it('三态文案', () => {
    expect(baselineStatusLabel('NOMINATED')).toBe('待确认');
    expect(baselineStatusLabel('CONFIRMED')).toBe('已确认');
    expect(baselineStatusLabel('REJECTED')).toBe('已驳回');
  });

  it('runName 优先，缺省回退 evalRunId', () => {
    const b = { evalRunId: 'run-id', runSummary: { runName: '三连跑 #9' } } as unknown as Parameters<typeof baselineRunLabel>[0];
    expect(baselineRunLabel(b)).toBe('三连跑 #9');
    expect(baselineRunLabel({ evalRunId: 'run-id' } as unknown as Parameters<typeof baselineRunLabel>[0])).toBe('run-id');
  });
});

describe('角色语义（BL-1：确认/驳回仅 ROLE-B）', () => {
  it('canDecideBaseline / decideDisabledHint', () => {
    expect(canDecideBaseline('B')).toBe(true);
    expect(canDecideBaseline('A')).toBe(false);
    expect(decideDisabledHint('A')).toContain('BL-1');
    expect(decideDisabledHint('B')).toBeNull();
  });

  it('roleHint 两角色文案可区分（浏览器档锚定用）', () => {
    expect(roleHint('A')).toContain('当前角色 A');
    expect(roleHint('B')).toContain('当前角色 B');
    expect(roleHint('A')).not.toBe(roleHint('B'));
  });

  it('decisionFailureHint：409 两类数据库守卫各有可读解释，其余码透传 null', () => {
    expect(decisionFailureHint('IMMUTABLE_VIOLATION')).toContain('已被裁定');
    expect(decisionFailureHint('CONFLICT')).toContain('每集至多一个');
    expect(decisionFailureHint('VALIDATION_FAILED')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 页面静态断言（readFile 范式，同 settings-providers-ui.spec）
// ---------------------------------------------------------------------------

describe('settings 页静态断言（占位退场 + 双 Tab 接线）', () => {
  // tests/ → src/：与 settings-providers-ui.spec 同一 ROOT 口径（不依赖 cwd）。
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pageSrc = readFileSync(resolve(ROOT, 'app/settings/page.tsx'), 'utf8');
  const gatesSrc = readFileSync(resolve(ROOT, 'app/settings/gates-rules-section.tsx'), 'utf8');
  const baselinesSrc = readFileSync(resolve(ROOT, 'app/settings/baselines-section.tsx'), 'utf8');

  it('page.tsx：PENDING_TABS 占位机制已摘除，四个 Tab 类型齐', () => {
    expect(pageSrc).not.toContain('PENDING_TABS');
    expect(pageSrc).not.toContain('上线）');
    expect(pageSrc).toContain("'gates'");
    expect(pageSrc).toContain("'baselines'");
    expect(pageSrc).toContain('GatesRulesSection');
    expect(pageSrc).toContain('BaselinesSection');
  });

  it('门禁规则 Tab：打真实 API，含派发历史入口，无 mock', () => {
    expect(gatesSrc).toContain('/api/gates');
    expect(gatesSrc).toContain('dispatch-logs');
    expect(gatesSrc).not.toContain('mockData');
    expect(gatesSrc).not.toContain('PlaceholderPage');
  });

  it('基线确认 Tab：BL-1 语义与禁用按钮真实存在，确认走 decision 接口', () => {
    expect(baselinesSrc).toContain('BL-1');
    expect(baselinesSrc).toContain('disabled=');
    expect(baselinesSrc).toContain('/decision');
    expect(baselinesSrc).not.toContain('mockData');
  });
});
