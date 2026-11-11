/**
 * `PG-06` 待测目标页面的展示口径单测。
 *
 * 三件「写错了也照常渲染」的事：
 *  1. T2 必须**置灰并标注「P1 支持」**——靠人工记忆去改是不行的，
 *     单点开关 `TARGET_T2_ENABLED` 一旦为 false，UI 与 API 必须同时拒绝；
 *  2. 版本语义文案的逐字原文（「保存后将生成 v2，历史运行仍引用 v1」）；
 *  3. `currentVersion === null` 时不得渲染出一份「空配置」，那会让人以为目标已可用。
 */
import { describe, expect, it } from 'vitest';
import type { Target, TargetVersion } from '@eval-platform/contracts';
import {
  T2_DISABLED_LABEL,
  currentVersionCell,
  isT2Selectable,
  modelCell,
  modelCellOf,
  nextVersionHint,
  promptSummary,
  targetKindLabel,
} from '../lib/ui/targets.js';

function version(config: TargetVersion['config']): TargetVersion {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    targetId: '00000000-0000-4000-8000-000000000002',
    versionNo: 1,
    config,
    createdBy: 'm1-local',
    createdAt: '2026-01-01T00:00:00+00:00',
  };
}

const t1 = version({
  kind: 't1_prompt',
  modelProviderId: '00000000-0000-4000-8000-000000000003',
  modelId: 'fixture-echo-1',
  promptTemplate: '请回答：{{input}}',
  temperature: 0.2,
  maxTokens: 512,
});

function target(currentVersion: TargetVersion | null): Target {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    name: '客服 T1',
    kind: 't1_prompt',
    currentVersionNo: currentVersion === null ? 0 : currentVersion.versionNo,
    createdAt: '2026-01-01T00:00:00+00:00',
    updatedAt: '2026-01-01T00:00:00+00:00',
    currentVersion,
  };
}

describe('类型列与 T2 置灰', () => {
  it('两种 kind 的中文标签', () => {
    expect(targetKindLabel('t1_prompt')).toBe('T1 Prompt');
    expect(targetKindLabel('t2_http')).toBe('T2 HTTP');
  });

  it('P0 期 T2 不可选，且标签逐字是「P1 支持」', () => {
    expect(isT2Selectable(false)).toBe(false);
    expect(T2_DISABLED_LABEL).toBe('P1 支持');
  });

  it('开关打开后 T2 可选（P1 只改这一处）', () => {
    expect(isT2Selectable(true)).toBe(true);
  });
});

describe('模型列', () => {
  it('T1 显示「模型标识」而不是内部 UUID', () => {
    expect(modelCell(target(t1))).toBe('fixture-echo-1');
  });

  it('没有当前版本时显示 — （不渲染空配置冒充可用）', () => {
    expect(modelCell(target(null))).toBe('—');
  });

  it('T2 显示 endpoint 主机名摘要（P1 才有数据）', () => {
    const t2 = version({
      kind: 't2_http',
      endpointUrl: 'https://api.example.com/generate',
      requestMapping: { 'messages.0.content': '{{input}}' },
      responseMapping: { answer: 'choices.0.message.content' },
      hasAuthHeader: true,
    });
    expect(modelCell(target(t2))).toBe('api.example.com');
  });

  it('版本历史直接吃 TargetVersion：不需要临时拼一个假 Target', () => {
    // 拼接假 Target 会带上一堆编造的字段（name / updatedAt），迟早被误读成真值。
    expect(modelCellOf(t1)).toBe('fixture-echo-1');
    expect(modelCellOf(null)).toBe('—');
  });
});

describe('当前版本列', () => {
  it('版本号从 1 开始，渲染为 v1', () => {
    expect(currentVersionCell(1)).toBe('v1');
    expect(currentVersionCell(12)).toBe('v12');
  });

  it('0 表示没有版本 ⇒ —，绝不渲染 v0（会让人以为存在一个空版本）', () => {
    expect(currentVersionCell(0)).toBe('—');
  });
});

describe('Prompt 摘要', () => {
  it('单行化并截断，保留 {{input}} 变量可辨识', () => {
    const multi = version({
      kind: 't1_prompt',
      modelProviderId: '00000000-0000-4000-8000-000000000003',
      modelId: 'fixture-echo-1',
      promptTemplate: '第一行\n第二行 {{input}}',
      temperature: 0.2,
      maxTokens: 512,
    });
    const summary = promptSummary(multi);
    expect(summary).not.toContain('\n');
    expect(summary).toContain('{{input}}');
  });

  it('超长模板截断且加省略号', () => {
    const long = version({
      kind: 't1_prompt',
      modelProviderId: '00000000-0000-4000-8000-000000000003',
      modelId: 'fixture-echo-1',
      promptTemplate: 'x'.repeat(120),
      temperature: 0.2,
      maxTokens: 512,
    });
    const summary = promptSummary(long);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBe(41);
  });

  it('没有当前版本时显示 —', () => {
    expect(promptSummary(null)).toBe('—');
  });
});

describe('版本语义文案（PG-06 原文）', () => {
  it('当前 v1 ⇒ 与事实文档逐字相同', () => {
    expect(nextVersionHint(1)).toBe('保存后将生成 v2，历史运行仍引用 v1');
  });

  it('版本号跟着实际版本走', () => {
    expect(nextVersionHint(4)).toBe('保存后将生成 v5，历史运行仍引用 v4');
  });
});
