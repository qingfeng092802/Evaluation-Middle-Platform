/**
 * 租约配置解析（`lib/lease`）与 worker 心跳生命周期。
 *
 * 约束（#6 方案 A）：
 *  - 心跳间隔与 TTL **都从配置读取**，不硬编码；
 *  - 心跳间隔 = `leaseDuration / 3`；
 *  - 配置里的 TTL 沿用了 PG interval 写法（`WORKER_STALE_AFTER='10 minutes'`），
 *    因为同一个值要原样交给 `reclaim_stale_runs(interval)`。
 *
 * 后者意味着 Node 侧必须能解析出**毫秒数**才能算心跳间隔。解析只支持
 * 「数字 + 单位」（可多段，如 `1 minute 30 seconds`），不支持 `ago` 之类
 * 与阈值无关的语法 —— 解析不了就**抛错**，绝不静默回退到硬编码默认值。
 */
import { describe, expect, it } from 'vitest';
import { leaseDurationMs, heartbeatIntervalMs, LEASE_HEARTBEAT_DIVISOR } from '../lib/lease/index.js';

describe('leaseDurationMs · 解析配置里的 TTL', () => {
  it('默认值 "10 minutes" ⇒ 600000ms', () => {
    expect(leaseDurationMs('10 minutes')).toBe(600_000);
  });

  it('对抗场景常用写法 "1 second" ⇒ 1000ms', () => {
    expect(leaseDurationMs('1 second')).toBe(1000);
  });

  it('多段 "1 minute 30 seconds" 累加', () => {
    expect(leaseDurationMs('1 minute 30 seconds')).toBe(90_000);
  });

  it('单位大小写与常见缩写都认："2 MINUTES" / "5s" / "500 ms"', () => {
    expect(leaseDurationMs('2 MINUTES')).toBe(120_000);
    expect(leaseDurationMs('5s')).toBe(5_000);
    expect(leaseDurationMs('500 ms')).toBe(500);
  });

  it('非法写法直接抛错，不静默回退', () => {
    expect(() => leaseDurationMs('')).toThrow();
    expect(() => leaseDurationMs('ten minutes')).toThrow();
    expect(() => leaseDurationMs('10 fortnights')).toThrow();
    expect(() => leaseDurationMs('ago')).toThrow();
  });

  it('非正数抛错（0 或负 TTL 会让回收吃掉一切）', () => {
    expect(() => leaseDurationMs('0 seconds')).toThrow();
    expect(() => leaseDurationMs('-1 minute')).toThrow();
  });
});

describe('heartbeatIntervalMs · 间隔 = TTL / 3', () => {
  it('除数固定为 3', () => {
    expect(LEASE_HEARTBEAT_DIVISOR).toBe(3);
  });

  it('10 分钟 TTL ⇒ 200s 心跳间隔', () => {
    expect(heartbeatIntervalMs(600_000)).toBe(200_000);
  });

  it('1 秒 TTL ⇒ 333ms（向下取整，且至少 1ms）', () => {
    expect(heartbeatIntervalMs(1000)).toBe(333);
  });

  it('极小 TTL 也不产生 0（setInterval(0) 会变成忙等）', () => {
    expect(heartbeatIntervalMs(2)).toBe(1);
  });
});
