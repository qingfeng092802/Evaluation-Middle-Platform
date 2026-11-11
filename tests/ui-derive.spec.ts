/**
 * 前端展示口径的纯逻辑单测（`[FE-01]` 的 DoD 中可被机器验证的部分）。
 *
 * 这些函数刻意与 React 解耦：把「哪个指标该站主位」「FAILED 该显示什么」
 * 这类**判断**抽成纯函数，才能在没有浏览器的情况下断言它们不会回归。
 * 组件只负责把结果渲染出来。
 */
import { describe, expect, it } from 'vitest';
import {
  describeRunStatus,
  emptyState,
  primaryMetricOf,
  runStatusAnimated,
  runStatusIcon,
  runStatusTone,
  scoreCell,
} from '../lib/ui/derive.js';

describe('describeRunStatus · RS-01…RS-06 文案（pages-and-flows §4.1）', () => {
  it('六态文案逐字对齐', () => {
    expect(describeRunStatus('PENDING')).toBe('待执行');
    expect(describeRunStatus('RUNNING')).toBe('运行中');
    expect(describeRunStatus('COMPLETED')).toBe('已完成');
    expect(describeRunStatus('PARTIAL_FAILED')).toBe('部分失败');
    expect(describeRunStatus('FAILED')).toBe('失败');
    expect(describeRunStatus('CANCELLED')).toBe('已中止');
  });
});

describe('runStatusTone · 语义色档（DESIGN §4.4）', () => {
  it('FAILED 与 PARTIAL_FAILED 不同档（红 vs 橙，不靠颜色单一区分）', () => {
    expect(runStatusTone('FAILED')).toBe('fail');
    expect(runStatusTone('PARTIAL_FAILED')).toBe('warn');
  });

  it('PENDING / CANCELLED 用中性档', () => {
    expect(runStatusTone('PENDING')).toBe('muted');
    expect(runStatusTone('CANCELLED')).toBe('muted');
  });

  it('RUNNING / COMPLETED 各用各的档', () => {
    expect(runStatusTone('RUNNING')).toBe('running');
    expect(runStatusTone('COMPLETED')).toBe('pass');
  });
});

describe('runStatusIcon / runStatusAnimated · DESIGN §4.4 图标与脉冲', () => {
  it('六态图标名逐一对齐（Lucide 名称，锁死跨版本改动）', () => {
    expect(runStatusIcon('PENDING')).toBe('Clock');
    expect(runStatusIcon('RUNNING')).toBe('Loader');
    expect(runStatusIcon('COMPLETED')).toBe('CircleCheck');
    expect(runStatusIcon('PARTIAL_FAILED')).toBe('TriangleAlert');
    expect(runStatusIcon('FAILED')).toBe('CircleX');
    expect(runStatusIcon('CANCELLED')).toBe('CircleSlash');
  });

  it('只有 RUNNING 呼吸脉冲（其余静止，尊重动效预算）', () => {
    expect(runStatusAnimated('RUNNING')).toBe(true);
    for (const s of ['PENDING', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'] as const) {
      expect(runStatusAnimated(s)).toBe(false);
    }
  });
});

describe('primaryMetricOf · FAILED 时 coverage 提到主位', () => {
  it('正常终态主位是 score_overall', () => {
    expect(primaryMetricOf('COMPLETED')).toBe('scoreOverall');
    expect(primaryMetricOf('PARTIAL_FAILED')).toBe('scoreOverall');
    expect(primaryMetricOf('RUNNING')).toBe('scoreOverall');
    expect(primaryMetricOf('PENDING')).toBe('scoreOverall');
  });

  it('FAILED 主位是 coverage', () => {
    expect(primaryMetricOf('FAILED')).toBe('coverage');
  });

  it('CANCELLED 主位仍是 score_overall（已完成的部分仍有意义）', () => {
    expect(primaryMetricOf('CANCELLED')).toBe('scoreOverall');
  });
});

describe('scoreCell · 缺失分数显示 — 而不是 0', () => {
  it('FAILED 运行的 score_overall=null 渲染为 —', () => {
    expect(scoreCell(null, 'FAILED')).toBe('—');
  });

  it('无 passThreshold 的 pass_rate=null 渲染为 —', () => {
    expect(scoreCell(null, 'COMPLETED')).toBe('—');
  });

  it('有值时按 4 位小数', () => {
    expect(scoreCell(0.6, 'COMPLETED')).toBe('0.6000');
    expect(scoreCell(0, 'COMPLETED')).toBe('0.0000');
  });
});

describe('emptyState · 空态文案逐字对齐（DESIGN §6.1，不得改写）', () => {
  it('PG-01 空态', () => {
    const s = emptyState('runs');
    expect(s.message).toBe('还没有评测记录。');
    expect(s.actions.map((a) => a.label)).toEqual(['去导入评测集', '去创建待测目标']);
    expect(s.actions.map((a) => a.href)).toEqual(['/datasets', '/targets']);
  });

  it('PG-05 上传零通过', () => {
    expect(emptyState('datasetUpload').message).toBe('没有可导入的有效记录，请检查文件格式。');
    expect(emptyState('datasetUpload').actions).toEqual([]);
  });

  it('PG-04 两个降级文案', () => {
    expect(emptyState('noReference').message).toBe('本条未提供参考答案');
    expect(emptyState('noBaseline').message).toBe('暂无基线，仅显示本次输出');
  });

  it('PG-01 未配凭证横幅', () => {
    expect(emptyState('noProviderCredentials').message).toBe(
      '尚未配置模型网关凭证，无法发起评测。',
    );
  });

  it('PG-02 三条阻塞文案逐字对齐（pages-and-flows §1 PG-02）', () => {
    expect(emptyState('blockedNoRetrieval').message).toBe(
      '当前数据集版本没有检索标注，无法计算 Recall@K。请更换版本或移除该算子。',
    );
    expect(emptyState('blockedNoEvaluators').message).toBe('请至少配置一个评测算子。');
    expect(emptyState('blockedNoCredentials').message).toBe(
      '尚未配置模型网关凭证，无法发起评测。',
    );
  });

  it('PG-06 版本语义文案', () => {
    expect(emptyState('targetVersionHint').message).toBe('保存后将生成 v2，历史运行仍引用 v1');
  });

  it('PG-05 版本不可变提示', () => {
    expect(emptyState('datasetVersionFrozen').message).toBe(
      '版本 v3 已发布，不可修改。如需调整数据，请导入并生成新版本。',
    );
  });

  it('OPEN-4 锁死句原样', () => {
    expect(emptyState('reproducibilityNotice').message).toBe('EvalRun 可解释，不可复现。');
  });
});
