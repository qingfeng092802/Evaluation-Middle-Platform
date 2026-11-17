/**
 * M4 Batch 4 前端派生层的单测（PG-07 / PG-09 / PG-10）。
 *
 * 这些判断都有「写错了也照常渲染」的特征：
 * 台账把 unknown 成本当 0 淡出、图表主题出现裸 hex、渠道重复入列、
 * 回调 Token 明文在关闭面板后还能再读出来。只有断言能拦住它们。
 */
import { describe, expect, it } from 'vitest';
import type { CostLedgerRow, CostLedgerSummary, EvaluatorTemplate, GateChannel, RegressionGate } from '@eval-platform/contracts';
import {
  defaultLedgerRange,
  ledgerBarOption,
  ledgerDimensionLabel,
  ledgerSummaryCards,
} from '../lib/ui/ledger.js';
import {
  canSubmitJudgeForm,
  judgeFormChanged,
  judgeFormOf,
  partitionTemplates,
  EMPTY_JUDGE_FORM,
} from '../lib/ui/evaluators.js';
import {
  channelsSummaryOf,
  closeTokenOnce,
  openTokenOnce,
  withChannel,
  withoutChannel,
} from '../lib/ui/channels.js';
import { chartThemeFromTokens } from '../lib/charts/theme.js';

const THEME = chartThemeFromTokens(() => 'rgb(1 2 3)');

// ---------------------------------------------------------------------------
// PG-10 台账
// ---------------------------------------------------------------------------

describe('ledger · 默认窗口与维度', () => {
  it('默认窗口是本月月初到现在（ISO 带 Z）', () => {
    const { from, to } = defaultLedgerRange(new Date('2026-11-18T10:30:00Z'));
    expect(from).toBe(new Date(2026, 10, 1).toISOString());
    expect(to).toBe('2026-11-18T10:30:00.000Z');
  });

  it('四维标签齐全', () => {
    expect(ledgerDimensionLabel('time')).toBe('时间');
    expect(ledgerDimensionLabel('model')).toBe('模型');
    expect(ledgerDimensionLabel('dataset')).toBe('评测集');
    expect(ledgerDimensionLabel('user')).toBe('发起人');
  });
});

describe('ledgerSummaryCards · unknown 成本必须露出（US-021）', () => {
  const base: CostLedgerSummary = {
    tokensIn: 100,
    tokensOut: 50,
    costTarget: 1.25,
    costJudge: 0.5,
    costTotal: 1.75,
    runCount: 3,
    unknownCostCases: 0,
  };

  it('unknown=0 ⇒ 不出现「成本未知」卡', () => {
    expect(ledgerSummaryCards(base).some((c) => c.label === '成本未知')).toBe(false);
  });

  it('unknown>0 ⇒ 出现卡片且写明「不得当作真实零成本」', () => {
    const cards = ledgerSummaryCards({ ...base, unknownCostCases: 2 });
    const unknown = cards.find((c) => c.label === '成本未知');
    expect(unknown).toBeDefined();
    expect(unknown?.value).toContain('2');
    expect(unknown?.hint).toContain('不得当作真实零成本');
  });
});

describe('ledgerBarOption · 主题走 Token，禁裸 hex（红线 10）', () => {
  const rows: CostLedgerRow[] = [
    { dimensionKey: 'm1', label: 'deepseek-chat', tokensIn: 1, tokensOut: 1, costTarget: 1, costJudge: 0, costTotal: 1, runCount: 1, unknownCostCases: 0 },
    { dimensionKey: 'm2', label: 'gpt-4o', tokensIn: 2, tokensOut: 2, costTarget: 2, costJudge: 0, costTotal: 2, runCount: 1, unknownCostCases: 0 },
  ];

  it('option 序列化后不含任何 # 开头色值', () => {
    const json = JSON.stringify(ledgerBarOption(rows, THEME));
    expect(json).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('系列色取自主题 current，类目轴用行 label', () => {
    const option = ledgerBarOption(rows, THEME) as {
      yAxis: { data: string[] };
      series: Array<{ itemStyle: { color: string } }>;
    };
    expect(option.yAxis.data).toEqual(['deepseek-chat', 'gpt-4o']);
    expect(option.series[0]?.itemStyle.color).toBe('rgb(1 2 3)');
  });
});

// ---------------------------------------------------------------------------
// PG-07 算子库
// ---------------------------------------------------------------------------

const builtin: EvaluatorTemplate = {
  id: '00000000-0000-4000-8000-00000000e005',
  key: 'regex',
  kind: 'rule',
  displayName: '正则命中',
  description: null,
  isBuiltin: true,
  version: 1,
  configSchema: {},
  defaultConfig: { key: 'regex', pattern: '.*', caseSensitive: false, shouldMatch: true },
  createdBy: null,
  createdAt: '1970-01-01T00:00:00Z',
  updatedAt: '1970-01-01T00:00:00Z',
};

const custom: EvaluatorTemplate = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'judge.rag',
  kind: 'judge',
  displayName: 'RAG 裁判',
  description: null,
  isBuiltin: false,
  version: 2,
  configSchema: {},
  defaultConfig: {
    key: 'judge',
    modelProviderId: '00000000-0000-4000-8000-000000000011',
    modelId: 'deepseek-chat',
    promptTemplate: '评 {{output}}',
    scaleMax: 5,
    passThreshold: 0.6,
    temperature: 0,
  },
  createdBy: 'local',
  createdAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-18T00:00:00Z',
};

describe('evaluators · 分区与表单', () => {
  it('内置/自定义分区不串（内置只读）', () => {
    const { builtin: b, custom: c } = partitionTemplates([custom, builtin]);
    expect(b.map((x) => x.key)).toEqual(['regex']);
    expect(c.map((x) => x.key)).toEqual(['judge.rag']);
  });

  it('编辑表单取模板现值；key 归模板（不可改）', () => {
    const form = judgeFormOf(custom);
    expect(form.key).toBe('judge.rag');
    expect(form.scaleMax).toBe(5);
    expect(canSubmitJudgeForm({ ...form })).toBe(true);
    // 仅改 displayName 不足以判定 config 变化（PATCH 不推版本）
    expect(judgeFormChanged(form, { ...form, displayName: 'x' })).toBe(false);
    expect(judgeFormChanged(form, { ...form, scaleMax: 10 })).toBe(true);
  });

  it('空表单不可提交（缺 key/名称/厂商/模型/Prompt 任意一项都拦）', () => {
    expect(canSubmitJudgeForm(EMPTY_JUDGE_FORM)).toBe(false);
    expect(canSubmitJudgeForm({ ...EMPTY_JUDGE_FORM, key: 'judge.x', displayName: 'x', modelProviderId: '00000000-0000-4000-8000-000000000011', modelId: 'm', promptTemplate: 'p' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PG-09 推送渠道 Tab
// ---------------------------------------------------------------------------

const gate = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'P0 得分红线',
  datasetId: '33333333-3333-4333-8333-333333333333',
  targetId: null,
  baselineId: null,
  condition: { metric: 'score_overall' as const, op: '<' as const, value: 0.85 },
  action: 'BLOCK' as const,
  isActive: true,
  channels: [
    { kind: 'feishu' as const, url: 'https://open.feishu.cn/hook/1' },
    { kind: 'webhook' as const, url: 'https://ci.example.com/hook' },
  ],
  createdBy: 'local',
  createdAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-18T00:00:00Z',
} satisfies RegressionGate;

describe('channels · 渠道摘要与去重', () => {
  it('摘要按 kind 计数；无渠道为空串（不渲染假渠道）', () => {
    expect(channelsSummaryOf(gate)).toBe('飞书×1 + 通用 Webhook×1');
    expect(channelsSummaryOf({ ...gate, channels: [] })).toBe('');
  });

  it('重复 kind+url 不重复入列（重复推送=重复告警）；删除按 kind+url 精确移除', () => {
    const feishu: GateChannel = { kind: 'feishu', url: 'https://open.feishu.cn/hook/1' };
    expect(withChannel(gate.channels, feishu)).toHaveLength(2);
    expect(withChannel(gate.channels, { kind: 'wecom', url: 'https://qy.example/hook' })).toHaveLength(3);
    expect(withoutChannel(gate.channels, feishu)).toHaveLength(1);
  });
});

describe('channels · 回调 Token 明文只显示一次', () => {
  it('关闭面板后 token 清空（不可从 state 再读出）', () => {
    const opened = openTokenOnce({ revealedToken: null, gateId: null }, gate.id, 'tok-plain');
    expect(opened.revealedToken).toBe('tok-plain');
    expect(opened.gateId).toBe(gate.id);
    const closed = closeTokenOnce(opened);
    expect(closed.revealedToken).toBeNull();
    expect(closed.gateId).toBeNull();
  });
});
