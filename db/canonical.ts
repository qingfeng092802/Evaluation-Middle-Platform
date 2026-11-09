/**
 * 规范化、指纹与 `case_key` 推导（持久化不变量）。
 *
 * **为什么放在 `db/` 而不是 `lib/import/`**：`content_hash` 是数据库层的唯一约束
 * （`ux_dataset_versions_dataset_hash`）与 409 冲突判定的依据，`seq` 也进 `dataset_cases`
 * 的非空列。它们是**落库不变量**，不是导入格式解析。而分层规则要求 `db` 只能依赖
 * `contracts`（`technical-solution.md` §3.7），所以这份实现必须住在 `db` 侧，
 * 由 `lib` 与 `app` 向上引用 —— 反过来会形成双向依赖。
 *
 * 口径锁定（SPEC-M1 R-1 / R-2 / R-3）：
 *  - **R-1 指纹**：`sha256(canonicalJson)` 的 64 位小写 hex。对象 key 递归字典序、
 *    数组保序、`cases` 按 `case_key` 升序、UTF-8。⇒ 同一内容任意行序 → 同 hash。
 *  - **R-2 序号**：`seq` = 按 `case_key` 升序的 0-based 下标，跨版本稳定。
 *  - **R-3 缺省键**：`case_key` 缺省 = `sha256(canonicalJson(input))` 前 16 位 hex。
 *
 * 为什么指纹要把 `seq` 排除在外：`seq` 是**由 case_key 排序后算出来的**，
 * 把它纳入指纹等于用指纹去证明指纹，且会让「只是输入顺序不同」误判成内容不同。
 */
import { createHash } from 'node:crypto';
import type { DatasetCaseInput } from '@eval-platform/contracts';
import { DATASET_SCHEMA_VERSION } from '@eval-platform/contracts';

/** 递归字典序的 canonical JSON。`undefined` 的键视为不存在（与 JSON 语义一致）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',');
  return `{${body}}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `case_key` 缺省值：规范化 input 的 hash 前 16 位。 */
export function deriveCaseKey(input: unknown): string {
  return sha256Hex(canonicalJson(input)).slice(0, 16);
}

/** 规范化后的 Case（已补 `caseKey` / `seq` / `metadata`）。 */
export interface NormalizedCase {
  readonly caseKey: string;
  readonly seq: number;
  readonly input: DatasetCaseInput['input'];
  readonly reference: DatasetCaseInput['reference'] | null;
  readonly retrieval: DatasetCaseInput['retrieval'] | null;
  readonly metadata: NonNullable<DatasetCaseInput['metadata']>;
}

/** 仅用于**深比较 / 参与指纹**的字段集合（刻意不含 `seq`）。 */
function fingerprintShape(c: NormalizedCase): Record<string, unknown> {
  return {
    caseKey: c.caseKey,
    input: c.input,
    reference: c.reference,
    retrieval: c.retrieval,
    metadata: c.metadata,
  };
}

/**
 * 补全缺省字段并按 `case_key` 升序编号。
 *
 * 排序口径是**字典序**（`String.prototype <`），与 SQL 的 `ORDER BY case_key`
 * 在 `en_US.UTF-8`/`C` 下对 ASCII 键一致；`case-0001…case-0050` 这类键完全等价。
 */
export function normalizeCases(cases: readonly DatasetCaseInput[]): NormalizedCase[] {
  const withKeys = cases.map((c) => ({
    caseKey: c.caseKey ?? deriveCaseKey(c.input),
    input: c.input,
    reference: c.reference ?? null,
    retrieval: c.retrieval ?? null,
    metadata: c.metadata ?? {},
  }));
  withKeys.sort((a, b) => (a.caseKey < b.caseKey ? -1 : a.caseKey > b.caseKey ? 1 : 0));
  return withKeys.map((c, i) => ({ ...c, seq: i }));
}

/**
 * 内容指纹（R-1）。
 *
 * 参与指纹的只有 `caseKey` / `input` / `reference` / `retrieval` / `metadata` ——
 * 也就是「这份数据是什么」；`seq` 是排序结果，不是数据。
 */
export function computeContentHash(cases: readonly DatasetCaseInput[]): string {
  const normalized = normalizeCases(cases).map(fingerprintShape);
  return sha256Hex(
    canonicalJson({ schemaVersion: DATASET_SCHEMA_VERSION, cases: normalized }),
  );
}
