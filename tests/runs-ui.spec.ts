/**
 * 运行页面展示口径的单测（`[FE-02]` / `[FE-03]` 可机器验证的部分）。
 *
 * 这些判断每一条都有「写错了也照常渲染」的特征：
 * 轮询不停、`PENDING` 显示 `0 / 0`、失败运行冒出分数、CSV 行号差一行。
 * 只有断言能拦住它们。
 */
import { describe, expect, it } from 'vitest';
import type { CaseResultStatus, EvalRun, Reproducibility, RunPreflight } from '@eval-platform/contracts';
import {
  caseKeyLabel,
  caseStatusLabel,
  caseStatusTone,
  importIssueLine,
  importSummary,
  metricCardsOf,
  operatorScoresSummary,
  progressLabel,
  progressPercent,
  reproducibilityRows,
  runCostLabel,
  runDurationLabel,
  runScoreLabel,
  showProviderBanner,
  shouldPoll,
} from '../lib/ui/runs.js';

// ---------------------------------------------------------------------------
// 轮询（[FE-03] 交付物 5）
// ---------------------------------------------------------------------------

describe('shouldPoll · 终态即停、页面不可见即停', () => {
  it('PENDING / RUNNING 且页面可见 ⇒ 继续轮询', () => {
    expect(shouldPoll('PENDING', false, true)).toBe(true);
    expect(shouldPoll('RUNNING', false, true)).toBe(true);
  });

  it('四个终态一律停止', () => {
    for (const s of ['COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'] as const) {
      expect(shouldPoll(s, false, true)).toBe(false);
    }
  });

  it('document.hidden 时暂停', () => {
    expect(shouldPoll('RUNNING', true, true)).toBe(false);
  });

  it('已卸载时停止（防 setState on unmounted）', () => {
    expect(shouldPoll('RUNNING', false, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 进度（[FE-03] 区域 3）
// ---------------------------------------------------------------------------

describe('progressLabel · PENDING 不是「0 / 0 Cases」', () => {
  it('PENDING 显示「等待调度」', () => {
    expect(
      progressLabel({ status: 'PENDING', totalCases: 50, succeededCases: 0, failedCases: 0 }),
    ).toBe('等待调度');
  });

  it('进行中无失败：已完成 N / M', () => {
    expect(
      progressLabel({ status: 'RUNNING', totalCases: 300, succeededCases: 128, failedCases: 0 }),
    ).toBe('已完成 128 / 300');
  });

  it('进行中带失败：末尾追加「失败 N」', () => {
    expect(
      progressLabel({ status: 'RUNNING', totalCases: 300, succeededCases: 126, failedCases: 2 }),
    ).toBe('已完成 128 / 300，失败 2');
  });

  it('失败的 Case 也计入「已完成」', () => {
    // 128 = 126 成功 + 2 失败；若只数 succeeded 会显示 126，与「失败 2」对不上
    expect(
      progressLabel({ status: 'PARTIAL_FAILED', totalCases: 300, succeededCases: 126, failedCases: 2 }),
    ).toBe('已完成 128 / 300，失败 2');
  });
});

describe('progressPercent · 边界不产生 NaN / 越界', () => {
  it('常规比例', () => {
    expect(progressPercent(128, 300)).toBeCloseTo(42.666, 2);
  });

  it('total 为 0 ⇒ 0（不是 NaN / Infinity）', () => {
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('超过总数时钳到 100', () => {
    expect(progressPercent(320, 300)).toBe(100);
  });

  it('负数钳到 0', () => {
    expect(progressPercent(-5, 300)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 列表单元格（[FE-02]/[FE-03]）
// ---------------------------------------------------------------------------

describe('runDurationLabel · 只有首尾都有时间才算得出耗时', () => {
  it('已结束：给秒', () => {
    expect(
      runDurationLabel({ startedAt: '2026-11-07T14:32:08.000Z', finishedAt: '2026-11-07T14:32:20.500Z' }),
    ).toBe('12.5 s');
  });

  it('不足 1 秒给毫秒', () => {
    expect(
      runDurationLabel({ startedAt: '2026-11-07T14:32:08.000Z', finishedAt: '2026-11-07T14:32:08.420Z' }),
    ).toBe('420 ms');
  });

  it('RUNNING（finishedAt 为 null）⇒ —，不用 now 补', () => {
    expect(runDurationLabel({ startedAt: '2026-11-07T14:32:08.000Z', finishedAt: null })).toBe('—');
  });

  it('未开始 ⇒ —', () => {
    expect(runDurationLabel({ startedAt: null, finishedAt: null })).toBe('—');
  });

  it('时间串非法 ⇒ —（不渲染 NaN）', () => {
    expect(runDurationLabel({ startedAt: 'oops', finishedAt: 'oops' })).toBe('—');
  });
});

describe('runScoreLabel · FAILED 永远显示 —', () => {
  const base = {
    status: 'FAILED',
    metrics: { scoreOverall: null, costTotal: 0 },
  } as unknown as EvalRun;

  it('FAILED 且分数为 null ⇒ —', () => {
    expect(runScoreLabel(base)).toBe('—');
  });

  it('即便数据层给 FAILED 补了分数，界面仍是 —（不自相矛盾）', () => {
    const dirty = {
      status: 'FAILED',
      metrics: { scoreOverall: 0.83, costTotal: 0 },
    } as unknown as EvalRun;
    expect(runScoreLabel(dirty)).toBe('—');
  });

  it('COMPLETED 正常给 4 位小数', () => {
    const ok = {
      status: 'COMPLETED',
      metrics: { scoreOverall: 0.6, costTotal: 0 },
    } as unknown as EvalRun;
    expect(runScoreLabel(ok)).toBe('0.6000');
  });
});

describe('runCostLabel · 汇总口径 2 位小数', () => {
  it('用 costTotal（数据库 STORED 列）而不是前端累加', () => {
    const run = {
      metrics: { costTotal: 12.4849, costTarget: 9, costJudge: 3.4849 },
    } as unknown as EvalRun;
    expect(runCostLabel(run)).toBe('$12.48');
  });
});

// ---------------------------------------------------------------------------
// 前置依赖横幅（[FE-03] 交付物 1）
// ---------------------------------------------------------------------------

describe('showProviderBanner · 只看凭证，不看 canStart', () => {
  const make = (hasProviderCredentials: boolean, canStart: boolean): RunPreflight =>
    ({
      hasProviderCredentials,
      hasEvaluators: true,
      retrievalReadiness: { state: 'NONE', annotatedCount: 0, totalCount: 0 },
      blockers: hasProviderCredentials ? [] : ['BLOCKED_NO_PROVIDER_CREDENTIALS'],
      canStart,
    }) as RunPreflight;

  it('未配凭证 ⇒ 显示横幅', () => {
    expect(showProviderBanner(make(false, false))).toBe(true);
  });

  it('已配凭证 ⇒ 不显示（即便 canStart=false 是别的原因）', () => {
    expect(showProviderBanner(make(true, false))).toBe(false);
  });

  it('尚未取到 preflight ⇒ 不显示（避免首帧闪一条假告警）', () => {
    expect(showProviderBanner(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 导入校验结果（PG-05 区域 3）
// ---------------------------------------------------------------------------

describe('importIssueLine · 行号直接取自服务端（D-11 物理行号）', () => {
  it('基础形态', () => {
    expect(importIssueLine({ line: 47, message: '缺少 case_key 且 input 为空' })).toBe(
      '第 47 行：缺少 case_key 且 input 为空',
    );
  });

  it('带字段名时前置 [field]', () => {
    expect(importIssueLine({ line: 48, field: 'case_key', message: '缺失' })).toBe(
      '第 48 行：[case_key] 缺失',
    );
  });

  it('不在前端做 ±1：CSV 表头已由服务端算进物理行号', () => {
    // 数据第 47 条 ⇒ CSV 报第 48 行。这条断言就是防止有人「顺手修一下」
    expect(importIssueLine({ line: 48, message: 'x' })).toContain('第 48 行');
  });
});

describe('importSummary', () => {
  it('两段计数', () => {
    expect(importSummary(298, 2)).toBe('通过 298 条 / 失败 2 条');
  });

  it('全失败也给得出（不显示成空串）', () => {
    expect(importSummary(0, 50)).toBe('通过 0 条 / 失败 50 条');
  });
});

// ---------------------------------------------------------------------------
// 明细表单元格（PG-03 区域 5）
// ---------------------------------------------------------------------------

describe('operatorScoresSummary', () => {
  it('按执行顺序拼接', () => {
    expect(
      operatorScoresSummary([
        { key: 'recall_at_k', score: 0.8 },
        { key: 'regex', score: 1 },
      ]),
    ).toBe('recall_at_k 0.8000 · regex 1.0000');
  });

  it('null / 空数组 ⇒ —', () => {
    expect(operatorScoresSummary(null)).toBe('—');
    expect(operatorScoresSummary([])).toBe('—');
  });
});

describe('caseKeyLabel · 超长键截断', () => {
  it('长键给「前 8…后 4」', () => {
    const key = 'case-0001-abcdef0123456789';
    expect(caseKeyLabel(key)).toBe('case-000…6789');
  });

  it('短键原样返回', () => {
    expect(caseKeyLabel('case-0001')).toBe('case-0001');
  });
});

// ---------------------------------------------------------------------------
// 详情页指标卡（PG-03 区域 2）
// ---------------------------------------------------------------------------

/** 只用到 `status` + `metrics`，用结构化最小类型避免在测试里造整个快照。 */
type RunLike = Parameters<typeof metricCardsOf>[0];

function runDetail(overrides: { status: EvalRun['status']; metrics?: RunLike['metrics'] }): RunLike {
  return {
    status: overrides.status,
    metrics: overrides.metrics ?? {
      scoreOverall: 0.6,
      passRate: 0.6,
      coverage: 1,
      latencyP50Ms: 120,
      latencyP95Ms: 480,
      tokensInTotal: 1500,
      tokensOutTotal: 600,
      costTarget: 0.0123,
      costJudge: 0,
      costTotal: 0.0123,
    },
  };
}

const FAILED_METRICS: RunLike['metrics'] = {
  scoreOverall: null,
  passRate: 0,
  coverage: 0,
  latencyP50Ms: null,
  latencyP95Ms: null,
  tokensInTotal: 0,
  tokensOutTotal: 0,
  costTarget: 0,
  costJudge: 0,
  costTotal: 0,
};

describe('metricCardsOf · FAILED 把 coverage 提到主位', () => {
  it('正常终态：第一张卡是「综合得分」，值 4 位小数', () => {
    const cards = metricCardsOf(runDetail({ status: 'COMPLETED' }));
    expect(cards[0]?.key).toBe('scoreOverall');
    expect(cards[0]?.value).toBe('0.6000');
    expect(cards[0]?.primary).toBe(true);
    expect(cards.filter((c) => c.primary)).toHaveLength(1);
  });

  it('FAILED：第一张卡换成「覆盖率」，综合得分仍在但显示 —', () => {
    const cards = metricCardsOf(runDetail({ status: 'FAILED', metrics: FAILED_METRICS }));
    expect(cards[0]?.key).toBe('coverage');
    expect(cards[0]?.value).toBe('0.00%');
    const score = cards.find((c) => c.key === 'scoreOverall');
    expect(score?.value).toBe('—');
    expect(score?.primary).toBe(false);
  });

  it('无 passThreshold ⇒ 通过率为 —，不是 0.00%', () => {
    const cards = metricCardsOf(
      runDetail({
        status: 'COMPLETED',
        metrics: { ...FAILED_METRICS, scoreOverall: 0.6, passRate: null, coverage: 1 },
      }),
    );
    expect(cards.find((c) => c.key === 'passRate')?.value).toBe('—');
  });

  it('八张卡都在，成本分列「待测」与「裁判」且不自己相加', () => {
    const cards = metricCardsOf(runDetail({ status: 'COMPLETED' }));
    expect(cards.map((c) => c.key)).toEqual([
      'scoreOverall',
      'passRate',
      'coverage',
      'latencyP50',
      'latencyP95',
      'tokens',
      'costTarget',
      'costJudge',
    ]);
    expect(cards.find((c) => c.key === 'costTarget')?.value).toBe('$0.01');
    expect(cards.find((c) => c.key === 'costJudge')?.value).toBe('$0.00');
  });
});

// ---------------------------------------------------------------------------
// 可复现性展开（PG-03 元数据栏 · OPEN-4）
// ---------------------------------------------------------------------------

describe('reproducibilityRows · 八个字段与 cache_policy: none', () => {
  const repro: Reproducibility = {
    temperature: 0.2,
    topP: 1,
    maxTokens: 512,
    seed: null,
    runnerVersion: 'm1.0.0',
    modelVersionString: null,
    promptTemplateHash: 'abcdef0123456789abcdef0123456789',
    cachePolicy: 'none',
  };

  it('字段名逐字取自 pages-and-flows.md PG-03', () => {
    expect(reproducibilityRows(repro).map((r) => r.label)).toEqual([
      'temperature',
      'top_p',
      'max_tokens',
      'seed',
      'runner_version',
      'model_version_string',
      'prompt_template_hash',
      'cache_policy',
    ]);
  });

  it('cache_policy 恒为 none（锁死口径，不是从数据里猜的）', () => {
    expect(reproducibilityRows(repro).at(-1)?.value).toBe('none');
  });

  it('null 字段显示 —（缺失 ≠ 0 / 空串）', () => {
    expect(reproducibilityRows(repro).find((r) => r.label === 'seed')?.value).toBe('—');
    expect(
      reproducibilityRows(repro).find((r) => r.label === 'model_version_string')?.value,
    ).toBe('—');
  });

  it('有值字段原样呈现', () => {
    expect(reproducibilityRows(repro).find((r) => r.label === 'temperature')?.value).toBe('0.2');
    expect(reproducibilityRows(repro).find((r) => r.label === 'max_tokens')?.value).toBe('512');
  });
});

// ---------------------------------------------------------------------------
// 明细表「状态」列（PG-03 区域 5）
// ---------------------------------------------------------------------------

describe('caseStatusLabel / caseStatusTone', () => {
  it('六种结果状态各有中文文案（不出现裸英文）', () => {
    const all: readonly CaseResultStatus[] = [
      'OK',
      'FAILED',
      'TIMEOUT',
      'PARSE_ERROR',
      'QUOTA_EXCEEDED',
      'SKIPPED',
    ];
    for (const s of all) {
      expect(caseStatusLabel(s)).not.toBe(s);
      expect(caseStatusLabel(s).length).toBeGreaterThan(0);
    }
    expect(caseStatusLabel('OK')).toBe('通过');
    expect(caseStatusLabel('SKIPPED')).toBe('跳过');
  });

  it('OK 绿档、SKIPPED 中性档、其余红档（非 OK 一律 score=NULL，不分严重度）', () => {
    expect(caseStatusTone('OK')).toBe('pass');
    expect(caseStatusTone('SKIPPED')).toBe('muted');
    for (const s of ['FAILED', 'TIMEOUT', 'PARSE_ERROR', 'QUOTA_EXCEEDED'] as const) {
      expect(caseStatusTone(s)).toBe('fail');
    }
  });
});
