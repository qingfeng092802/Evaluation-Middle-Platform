/**
 * 并发闸门（Batch 3 · 交付物 1「并发峰值 ≤ `max_concurrency`」）。
 *
 * ## 为什么不能用 `p-limit` 直接了事
 *
 * `p-limit` 只认一个数字。可执行路径上**有两个**数字：
 *
 *   - `eval_runs.concurrency` —— **用户意图**（「我想跑快点」）；
 *   - `model_providers.max_concurrency` —— **物理上限**（厂商/账号能吃多少）。
 *
 * 两者冲突时物理上限优先。把 `max(...)` 或只用 run 的那个写进去，症状是
 * 「厂商被压到 429，而页面上一切正常」——所以生效值必须由这里**算一次**，
 * 且能被打日志/测试读到，而不是各调用点各取一个。
 *
 * ## 为什么是「按厂商」而不是「按 run」
 *
 * 同一个厂商可能被多个 run 同时使用（两个 worker、两个并发 run）。
 * 若每个 run 各开一个 `p-limit(2)`，厂商看到的是 4。因此闸门挂在
 * **厂商 id** 上，进程内共享；跨进程的严格全局限流交给 LiteLLM sidecar
 * （`litellm-config.ts` 的 `max_parallel_requests`），这一层管的是
 * 「单个 worker 进程内不超发」。
 */
import pLimit, { type LimitFunction } from 'p-limit';

/** 单个 run 允许的并发上限（`technical-solution.md` §3.5 [3]：上限 32）。 */
export const RUN_CONCURRENCY_CEILING = 32;

/**
 * 计算实际生效的并发度。
 *
 * 返回 `{ effective, cappedBy }`，`cappedBy` 用于日志：当厂商上限真的压低了
 * 用户意图时，运维能一眼看出「慢是因为厂商只给了 2」，而不是去查 run 配置。
 */
export interface EffectiveConcurrency {
  readonly effective: number;
  readonly runLimit: number;
  readonly providerLimit: number;
  /** `provider` 表示被厂商上限卡住（用户意图未生效）。 */
  readonly cappedBy: 'run' | 'provider';
}

export function effectiveConcurrency(input: {
  readonly runConcurrency: number;
  readonly providerMaxConcurrency: number;
}): EffectiveConcurrency {
  // 0 / NaN / 负数一律按 1 处理：并发为 0 会让 `Promise.all([])` 直接返回，
  // run 看起来「跑完了」但一条结果都没有 —— 这种静默失败比报错难查得多。
  const runLimit = Math.max(1, Math.min(Math.trunc(input.runConcurrency) || 1, RUN_CONCURRENCY_CEILING));
  const providerLimit = Math.max(1, Math.trunc(input.providerMaxConcurrency) || 1);
  const effective = Math.min(runLimit, providerLimit);
  return {
    effective,
    runLimit,
    providerLimit,
    cappedBy: providerLimit < runLimit ? 'provider' : 'run',
  };
}

/**
 * 进程内按厂商共享的限流器。
 *
 * 同一厂商的多个 run 共用一个 `p-limit` 实例，保证「两个 run 同时跑」不会
 * 把并发度翻倍。用 `Map` + 厂商 id 作为键；进程退出即释放，不需要清理。
 *
 * ⚠️ 这是**进程内**共享。`WORKER_CONCURRENCY` 起多个 worker 进程时，
 * 每个进程各有一份 —— 全局限流由 sidecar 兜底。两条路都留着，
 * 因为「没有 sidecar 的直连部署」也必须不把厂商打爆。
 */
const limiters = new Map<string, LimitFunction>();

export function providerLimiter(providerId: string, concurrency: number): LimitFunction {
  const existing = limiters.get(providerId);
  // 先建的赢：并发度是「厂商能吃多少」，运行中改 PG-09 不该让**正在跑的**
  // 闸门变大变小。要让新值生效，重启 worker 即可（重启会重建 Map）。
  if (existing) return existing;
  const created = pLimit(Math.max(1, concurrency));
  limiters.set(providerId, created);
  return created;
}

/** 测试用：清掉进程内缓存，避免用例之间互相影响。 */
export function resetProviderLimiters(): void {
  limiters.clear();
}
