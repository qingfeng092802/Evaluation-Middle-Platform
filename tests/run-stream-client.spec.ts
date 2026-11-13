/**
 * 前端 SSE 进度状态机（Batch 3 · 交付物 4/5）。
 *
 * 为什么把这一段单独抽成纯函数：这里是**重连后进度不倒退、不重复计数**的唯一落点，
 * 而它恰恰是浏览器里最难复现的一类缺陷 ——
 *
 *  - 按事件累加（`completedCount = 上一条 + 1`）⇒ 断线重连一次就多计一遍，
 *    进度条冲到 110%，而且**只有断过线的人才看得见**；
 *  - 接受比当前值更小的事件（重连时缓冲区里的旧帧）⇒ 进度条往回跳；
 *  - `snapshot` 之后仍按「同一 caseKey」再计一次失败 ⇒ 失败数翻倍。
 *
 * 这三条在 Node 里都能用纯函数精确断言，不必起浏览器；页面只负责把
 * `EventSource` 收到的帧喂进来。
 */
import { describe, expect, it } from 'vitest';
import type { EvalProgressFrame, RunStatus } from '@eval-platform/contracts';
import {
  INITIAL_STREAM_PROGRESS,
  applyFrame,
  connectionLabel,
  connectionTone,
  milestoneOf,
  shouldAnnounce,
  type StreamConnection,
  type StreamProgress,
} from '../lib/ui/run-stream-client.js';

/** 造一帧；`id` 与 `runId` 用常量，本文件只关心计数语义。 */
const RUN = '11111111-1111-4111-8111-111111111111';

function snapshot(completed: number, failed: number, total: number, status: RunStatus = 'RUNNING'): EvalProgressFrame {
  const succeeded = completed - failed;
  return {
    id: `${RUN}:0`,
    event: 'snapshot',
    data: {
      type: 'snapshot',
      runId: RUN,
      status,
      counts: { totalCases: total, succeededCases: succeeded, failedCases: failed, skippedCases: 0 },
      metrics: {
        scoreOverall: null,
        passRate: null,
        coverage: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
        tokensInTotal: 0,
        tokensOutTotal: 0,
        costTarget: 0,
        costJudge: 0,
        costTotal: 0,
      },
      startedAt: null,
      finishedAt: null,
    },
    retryMs: null,
  };
}

function caseFrame(
  seq: number,
  ordinal: number,
  total: number,
  status: 'OK' | 'FAILED' = 'OK',
  caseKey = `c-${String(ordinal)}`,
): EvalProgressFrame {
  return {
    id: `${RUN}:${String(seq)}`,
    event: 'case',
    data: {
      type: 'case',
      runId: RUN,
      caseKey,
      completedCount: ordinal,
      totalCount: total,
      score: status === 'OK' ? 0.8 : null,
      passed: status === 'OK',
      status,
      latencyMs: 12,
    },
    retryMs: null,
  };
}

function statusFrame(to: RunStatus, seq = 9): EvalProgressFrame {
  return {
    id: `${RUN}:${String(seq)}`,
    event: 'status',
    data: { type: 'status', runId: RUN, from: 'RUNNING', to, at: '2026-11-13T00:00:00.000Z' },
    retryMs: null,
  };
}

function applyAll(frames: readonly EvalProgressFrame[]): StreamProgress {
  return frames.reduce<StreamProgress>((s, f) => applyFrame(s, f), INITIAL_STREAM_PROGRESS);
}

describe('applyFrame · snapshot 是唯一真相，永远替换而不是累加', () => {
  it('首帧 snapshot 直接给出计数，不做任何 `+1`', () => {
    const s = applyAll([snapshot(5, 2, 50)]);
    expect(s.completedCount).toBe(5);
    expect(s.totalCount).toBe(50);
    expect(s.failedCount).toBe(2);
    expect(s.runStatus).toBe('RUNNING');
  });

  it('重连再来一次 snapshot ⇒ 仍然是库里的真值（不是 5 + 5）', () => {
    const s = applyAll([snapshot(5, 2, 50), caseFrame(1, 6, 50), snapshot(6, 2, 50)]);
    expect(s.completedCount).toBe(6);
    expect(s.failedCount).toBe(2);
  });

  it('snapshot 重置「已见过」集合：重连后不会因为旧事件而重复计失败', () => {
    const first = applyAll([snapshot(0, 0, 10), caseFrame(1, 1, 10, 'FAILED', 'c-1')]);
    expect(first.failedCount).toBe(1);

    // 断线后重连：快照说失败 1 条；随后同一条 case 的陈旧事件再次到达
    const reconnected = applyFrame(first, snapshot(1, 1, 10));
    const afterStale = applyFrame(reconnected, caseFrame(2, 1, 10, 'FAILED', 'c-1'));
    expect(afterStale.failedCount).toBe(1);
    expect(afterStale.completedCount).toBe(1);
  });
});

describe('applyFrame · case 事件不倒退、不重复计数', () => {
  it('completedCount 单调递增：比当前值小的旧事件被丢弃', () => {
    const s = applyAll([snapshot(3, 0, 10), caseFrame(1, 2, 10, 'OK', 'c-2')]);
    expect(s.completedCount).toBe(3);
  });

  it('同一 caseKey 重复到达只计一次', () => {
    const s = applyAll([
      snapshot(0, 0, 10),
      caseFrame(1, 1, 10, 'FAILED', 'c-1'),
      caseFrame(2, 1, 10, 'FAILED', 'c-1'),
    ]);
    expect(s.completedCount).toBe(1);
    expect(s.failedCount).toBe(1);
  });

  it('失败计入 failedCount，成功不计', () => {
    const s = applyAll([
      snapshot(0, 0, 10),
      caseFrame(1, 1, 10, 'OK', 'c-1'),
      caseFrame(2, 2, 10, 'FAILED', 'c-2'),
    ]);
    expect(s.completedCount).toBe(2);
    expect(s.failedCount).toBe(1);
  });

  it('保留最新一条 Case 的摘要（喂给进度条的 score / passed / latencyMs）', () => {
    const s = applyAll([snapshot(0, 0, 10), caseFrame(1, 1, 10, 'OK', 'c-1')]);
    expect(s.latest).toEqual({ score: 0.8, passed: true, latencyMs: 12 });
  });
});

describe('applyFrame · status / heartbeat / error', () => {
  it('status 改运行状态，不动计数', () => {
    const s = applyAll([snapshot(4, 0, 10), statusFrame('COMPLETED')]);
    expect(s.runStatus).toBe('COMPLETED');
    expect(s.completedCount).toBe(4);
  });

  it('heartbeat 完全无副作用（它不是"清零"信号）', () => {
    const before = applyAll([snapshot(4, 0, 10)]);
    const after = applyFrame(before, {
      id: `${RUN}:7`,
      event: 'heartbeat',
      data: { type: 'heartbeat', at: '2026-11-13T00:00:00.000Z' },
      retryMs: null,
    });
    expect(after.completedCount).toBe(4);
    expect(after.totalCount).toBe(10);
  });

  it('error 事件不改计数（单条失败 ≠ 整个运行失败）', () => {
    const before = applyAll([snapshot(4, 0, 10)]);
    const after = applyFrame(before, {
      id: `${RUN}:8`,
      event: 'error',
      data: { type: 'error', runId: RUN, code: 'GATEWAY', message: 'x' },
      retryMs: null,
    });
    expect(after.completedCount).toBe(before.completedCount);
    expect(after.failedCount).toBe(before.failedCount);
    expect(after.totalCount).toBe(before.totalCount);
  });
});

describe('连接三态（DESIGN §4.2）', () => {
  it('文案逐字：已连接 / 重连中 / 已断开', () => {
    expect(connectionLabel('connected')).toBe('已连接');
    expect(connectionLabel('reconnecting')).toBe('重连中');
    expect(connectionLabel('disconnected')).toBe('已断开');
  });

  it('色调：已连接 running、重连中 warn、已断开 fail', () => {
    expect(connectionTone('connected')).toBe('running');
    expect(connectionTone('reconnecting')).toBe('warn');
    expect(connectionTone('disconnected')).toBe('fail');
  });
});

describe('milestoneOf / shouldAnnounce · 只播报连接变化与 10% 里程碑', () => {
  it('里程碑按 10% 向下取整', () => {
    expect(milestoneOf(0, 100)).toBe(0);
    expect(milestoneOf(9, 100)).toBe(0);
    expect(milestoneOf(10, 100)).toBe(10);
    expect(milestoneOf(42, 100)).toBe(40);
    expect(milestoneOf(100, 100)).toBe(100);
  });

  it('total 为 0 ⇒ 0（不产生 NaN）', () => {
    expect(milestoneOf(3, 0)).toBe(0);
  });

  it('同一条 Case 不触发播报（读屏不会被刷爆）', () => {
    expect(
      shouldAnnounce({ connection: 'connected', milestone: 40 }, { connection: 'connected', milestone: 40 }),
    ).toBe(false);
  });

  it('跨过 10% 里程碑 ⇒ 播报', () => {
    expect(
      shouldAnnounce({ connection: 'connected', milestone: 40 }, { connection: 'connected', milestone: 50 }),
    ).toBe(true);
  });

  it('连接态变化 ⇒ 必播报（即便进度没动）', () => {
    const pairs: readonly [StreamConnection, StreamConnection][] = [
      ['connected', 'reconnecting'],
      ['reconnecting', 'connected'],
      ['reconnecting', 'disconnected'],
    ];
    for (const [a, b] of pairs) {
      expect(shouldAnnounce({ connection: a, milestone: 30 }, { connection: b, milestone: 30 })).toBe(true);
    }
  });

  it('回退到更小的里程碑也播报（进度倒退是异常，必须让用户知道）', () => {
    expect(
      shouldAnnounce({ connection: 'connected', milestone: 60 }, { connection: 'connected', milestone: 40 }),
    ).toBe(true);
  });
});
