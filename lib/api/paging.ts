/**
 * 分页小工具。
 *
 * 由于分页响应体在 `contracts/api.ts` 里是**每个实体各自声明**的（刻意不用泛型，
 * 规避 Zod v3/v4 泛型签名差异），这里只提供 `PageMeta` 的构造，不提供泛型包装器。
 */
import type { PageMeta } from '@eval-platform/contracts';

/** M1 列表页一次性拉取，不做游标分页；`nextCursor` 恒为 null。 */
export function pageMeta(total?: number): PageMeta {
  return total === undefined ? { nextCursor: null } : { nextCursor: null, total };
}

/** 逗号分隔的查询串数组（`?evaluatorKeys=a,b`）。 */
export function csvList(v: string | null): string[] {
  if (v === null) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
