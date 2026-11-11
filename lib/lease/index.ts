/**
 * 租约（lease）配置工具。
 *
 * 为什么放在 `lib/`：worker 与未来的 API（比如展示进度）都要用它，
 * 而它不碰数据库、不碰进程状态 —— 是纯函数。
 *
 * TTL 的配置形态沿用 `WORKER_STALE_AFTER` 的 PG interval 字符串
 * （同一个值要原样交给 `reclaim_stale_runs(interval)`），
 * 这里只负责把它解析成毫秒，用来推导心跳间隔。
 */

/** 心跳间隔 = 租约 TTL / 该除数（方案 A 的硬性比例）。 */
export const LEASE_HEARTBEAT_DIVISOR = 3;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

const PART = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

/**
 * 把 PG interval 的常见写法解析成毫秒。
 *
 * 支持多段累加（`1 minute 30 seconds`），单位不区分大小写。
 * **解析不了就抛错**：静默回退到默认值会让一个写错的配置看起来「生效了」，
 * 这在租约语义下等于「回收阈值不是你写的那个值」。
 */
export function leaseDurationMs(text: string): number {
  const raw = text.trim();
  if (!raw) throw new Error('租约 TTL 为空：请配置 WORKER_STALE_AFTER');

  let total = 0;
  let matched = 0;
  for (const m of raw.matchAll(PART)) {
    const unit = UNIT_MS[(m[2] ?? '').toLowerCase()];
    if (unit === undefined) {
      throw new Error(`无法解析租约 TTL「${text}」：未知单位「${m[2] ?? ''}」`);
    }
    total += Number(m[1]) * unit;
    matched += 1;
  }

  // 去掉已匹配的片段后必须什么都不剩（拦住 "-1 minute" / "10 minutes ago" 之类）
  const leftover = raw.replace(PART, '').replace(/[\s,]/g, '');
  if (matched === 0 || leftover.length > 0) {
    throw new Error(`无法解析租约 TTL「${text}」（期望形如 "10 minutes" / "30s"）`);
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`租约 TTL 必须为正数，实际「${text}」`);
  }
  return Math.round(total);
}

/**
 * 心跳间隔 = `TTL / 3`。
 *
 * 下限 1ms：`setInterval(0)` 在 Node 里会退化成极短周期的忙等，
 * 而 TTL 小于 3ms 本身就不是有意义的配置。
 */
export function heartbeatIntervalMs(ttlMs: number): number {
  return Math.max(1, Math.floor(ttlMs / LEASE_HEARTBEAT_DIVISOR));
}
