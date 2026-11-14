/**
 * `scripts/pw-local.ts` 的 `waitUntil`。
 *
 * ## 为什么这条要有单测
 *
 * 它替代了浏览器测试里几十处 `waitForTimeout(n)`。这类辅助函数一旦写错，
 * 表现是「测试全绿」——因为超时后**静默放行**。真栈联调里踩过的正是这个：
 * `waitForTimeout(2_500)` 等一个冷编译要 2.8s 的接口，冷缓存下必红、
 * 热缓存下白等 2.5s，两种都不对。
 *
 * 所以这里钉三件事：
 *  1. 条件立刻成立时**立即返回**，不空转；
 *  2. 条件后来成立时**等到它成立**（而不是等固定时长）；
 *  3. 超时**抛错**且错误文案原样带出（跳过 ≠ 通过）。
 */
import { describe, expect, it } from 'vitest';
import { waitUntil } from '../scripts/pw-local.js';

describe('waitUntil', () => {
  it('条件一开始就成立 ⇒ 立即返回，不额外等待', async () => {
    const started = Date.now();
    await waitUntil(async () => true, { timeoutMs: 5_000, message: '不该超时' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('条件在第 3 次轮询成立 ⇒ 返回（等的是条件，不是固定时长）', async () => {
    let calls = 0;
    const started = Date.now();
    await waitUntil(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      { timeoutMs: 5_000, intervalMs: 20, message: '不该超时' },
    );
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('超时 ⇒ 抛错，且错误文案是调用方给的那句', async () => {
    await expect(
      waitUntil(async () => false, {
        timeoutMs: 120,
        intervalMs: 20,
        message: '校验结果在 30s 内没有渲染出来',
      }),
    ).rejects.toThrow('校验结果在 30s 内没有渲染出来');
  });

  it('probe 抛错 ⇒ 错误向上冒泡，不被吞成「超时」', async () => {
    await expect(
      waitUntil(
        async () => {
          throw new Error('页面已关闭');
        },
        { timeoutMs: 5_000, message: '不该走到超时' },
      ),
    ).rejects.toThrow('页面已关闭');
  });
});
