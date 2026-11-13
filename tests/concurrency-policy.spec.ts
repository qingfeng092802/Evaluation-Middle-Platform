/**
 * 并发生效值的**取哪个数**（Batch 3 · 交付物 1 的纯函数半边）。
 *
 * 真进程测试（`concurrency-ceiling.spec.ts`）证明「厂商侧观测到的峰值不超限」；
 * 这个文件证明「为什么不超限是对的」—— 两个数字冲突时取谁、异常值怎么兜。
 *
 * 这几条都属于「写错了页面完全正常」的类别：
 *  - 取 `max` 而不是 `min`：厂商上限形同虚设；
 *  - 不兜 0 / NaN：`pLimit(0)` 会让所有任务永久挂起（run 卡在 RUNNING 直到被回收）；
 *  - 忘了 32 的天花板：run 配 1000 会把本机文件描述符打满。
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveConcurrency,
  providerLimiter,
  resetProviderLimiters,
  RUN_CONCURRENCY_CEILING,
} from '../lib/runner/concurrency.js';

describe('effectiveConcurrency · 两个上限取更紧的那个', () => {
  it('厂商上限更紧 ⇒ 生效值是厂商上限，并标记受限方', () => {
    const r = effectiveConcurrency({ runConcurrency: 6, providerMaxConcurrency: 2 });
    expect(r.effective).toBe(2);
    expect(r.cappedBy).toBe('provider');
  });

  it('run 更紧 ⇒ 生效值是 run，受限方为 run', () => {
    const r = effectiveConcurrency({ runConcurrency: 2, providerMaxConcurrency: 8 });
    expect(r.effective).toBe(2);
    expect(r.cappedBy).toBe('run');
  });

  it('相等 ⇒ 不谎称被厂商卡住（cappedBy 取 run）', () => {
    const r = effectiveConcurrency({ runConcurrency: 4, providerMaxConcurrency: 4 });
    expect(r.effective).toBe(4);
    expect(r.cappedBy).toBe('run');
  });

  it('run 并发超过 32 ⇒ 被天花板截断（文件描述符保护）', () => {
    const r = effectiveConcurrency({ runConcurrency: 1000, providerMaxConcurrency: 64 });
    expect(r.runLimit).toBe(RUN_CONCURRENCY_CEILING);
    expect(r.effective).toBe(RUN_CONCURRENCY_CEILING);
  });

  it('0 / 负数 / NaN 一律按 1（否则 pLimit(0) 会让任务永久挂起）', () => {
    for (const bad of [0, -3, Number.NaN]) {
      expect(effectiveConcurrency({ runConcurrency: bad, providerMaxConcurrency: 4 }).effective).toBe(1);
      expect(effectiveConcurrency({ runConcurrency: 4, providerMaxConcurrency: bad }).effective).toBe(1);
    }
  });

  it('小数向下取整（并发只能是整数）', () => {
    expect(effectiveConcurrency({ runConcurrency: 3.9, providerMaxConcurrency: 8 }).effective).toBe(3);
  });
});

describe('providerLimiter · 按厂商共享', () => {
  it('同一厂商拿到同一个实例（两个 run 不会各开一个闸门）', () => {
    resetProviderLimiters();
    const a = providerLimiter('p-1', 2);
    const b = providerLimiter('p-1', 5);
    // 第二个参数被忽略：先建的赢
    expect(a).toBe(b);
  });

  it('不同厂商互不影响', () => {
    resetProviderLimiters();
    const a = providerLimiter('p-1', 2);
    const b = providerLimiter('p-2', 2);
    expect(a).not.toBe(b);
  });

  it('确实限住了同时在途数量', async () => {
    resetProviderLimiters();
    const limit = providerLimiter('p-x', 2);
    let inFlight = 0;
    let peak = 0;
    const task = (): Promise<void> =>
      limit(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });
});
