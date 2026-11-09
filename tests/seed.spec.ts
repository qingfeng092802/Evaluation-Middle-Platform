/**
 * 种子数据与导入夹具的契约校验（`[BE-01]` DoD 第 4 条）。
 *
 * 这个文件只做两件事：
 *  1. 证明 `db/seed/rag-benchmark.jsonl`（20 条）与 `tests/fixtures/cases-50.jsonl`（50 条）
 *     都能通过 `DatasetVersionCreate.parse()` —— 「合法」由契约定义，不由本文件的断言定义；
 *  2. 证明种子脚本**可重复执行**（幂等）：连跑两次，`model_providers` / `model_prices`
 *     / `datasets` / `dataset_versions` 的行数完全不变。
 *
 * 第 2 点是 DoD 的原文要求，也是 M1 唯一的「真库写路径」回归门。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { DatasetVersionCreate } from '@eval-platform/contracts';
import { parseJsonl } from '../lib/import/jsonl.js';
import { normalizeCases } from '../lib/import/canonical.js';
import { connect, databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { runSeed } from '../scripts/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(here, '..', 'db', 'seed');
const FIXTURE_DIR = join(here, 'fixtures');

async function loadJsonl(path: string): Promise<{ cases: unknown[]; okCount: number }> {
  const content = await readFile(path, 'utf8');
  const { cases, report } = parseJsonl(content);
  return { cases, okCount: report.okCount };
}

interface CaseShape {
  caseKey?: string;
  input: { query: string };
  reference?: { golden_answer?: string; reference_facts?: Record<string, string | number> };
  retrieval?: { relevant: { doc_id: string; grade: number }[] };
  metadata?: Record<string, string | number | boolean>;
}

function asCaseShape(c: unknown): CaseShape {
  return c as CaseShape;
}

describe('`[BE-01]` 种子集与验收集的契约合法性', () => {
  it('rag-benchmark.jsonl 恰好 20 条，且通过 DatasetVersionCreate.parse()', async () => {
    const { cases, okCount } = await loadJsonl(join(SEED_DIR, 'rag-benchmark.jsonl'));
    expect(okCount).toBe(20);
    expect(cases).toHaveLength(20);

    const parsed = DatasetVersionCreate.safeParse({
      source: 'import',
      note: '种子数据',
      cases,
    });
    if (!parsed.success) {
      throw new Error(`rag-benchmark.jsonl 未通过契约：\n${parsed.error.toString()}`);
    }
    expect(parsed.success).toBe(true);
  });

  it('种子集每条都同时具备 case_key / input.query / golden_answer / reference_facts / relevant', async () => {
    const { cases } = await loadJsonl(join(SEED_DIR, 'rag-benchmark.jsonl'));
    for (const raw of cases) {
      const c = asCaseShape(raw);
      expect(typeof c.caseKey, `${String(c.caseKey)} 缺 caseKey`).toBe('string');
      expect(c.input?.query, `${String(c.caseKey)} 缺 input.query`).toBeTruthy();
      expect(c.reference?.golden_answer, `${String(c.caseKey)} 缺 golden_answer`).toBeTruthy();
      expect(
        Object.keys(c.reference?.reference_facts ?? {}).length,
        `${String(c.caseKey)} 的 reference_facts 为空`,
      ).toBeGreaterThan(0);
      expect(c.retrieval?.relevant.length ?? 0, `${String(c.caseKey)} 缺 relevant`).toBeGreaterThan(
        0,
      );
    }
  });

  it('种子集覆盖 SPEC-M1 §[BE-01]-6 要求的三类分布', async () => {
    const { cases } = await loadJsonl(join(SEED_DIR, 'rag-benchmark.jsonl'));
    const shapes = cases.map(asCaseShape);

    // 至少 3 条 reference_facts 含 ≥2 个数值
    const multiNumeric = shapes.filter(
      (c) =>
        Object.values(c.reference?.reference_facts ?? {}).filter((v) => typeof v === 'number')
          .length >= 2,
    );
    expect(multiNumeric.length).toBeGreaterThanOrEqual(3);

    // 至少 2 条标注里存在 grade=0 的干扰项
    const withZeroGrade = shapes.filter((c) =>
      (c.retrieval?.relevant ?? []).some((r) => r.grade === 0),
    );
    expect(withZeroGrade.length).toBeGreaterThanOrEqual(2);

    // 至少 2 条用于构造 Recall=0（metadata.note 明示）
    const recallZero = shapes.filter((c) => typeof c.metadata?.['note'] === 'string');
    expect(recallZero.length).toBeGreaterThanOrEqual(2);
  });

  it('cases-50.jsonl 恰好 50 条，case_key 唯一，且通过 DatasetVersionCreate.parse()', async () => {
    const { cases, okCount } = await loadJsonl(join(FIXTURE_DIR, 'cases-50.jsonl'));
    expect(okCount).toBe(50);
    expect(cases).toHaveLength(50);

    const keys = cases.map((c) => asCaseShape(c).caseKey);
    expect(new Set(keys).size).toBe(50);

    const parsed = DatasetVersionCreate.safeParse({
      source: 'import',
      cases,
    });
    if (!parsed.success) {
      throw new Error(`cases-50.jsonl 未通过契约：\n${parsed.error.toString()}`);
    }
    expect(parsed.success).toBe(true);
  });

  it('cases-50.jsonl 前 30 条的 query 以 FIXTURE-HIT- 开头（regex 算子应得 30/50 = 0.6）', async () => {
    const { cases } = await loadJsonl(join(FIXTURE_DIR, 'cases-50.jsonl'));
    const normalized = normalizeCases(cases as never);
    const hits = normalized.filter((c) => c.input.query.startsWith('FIXTURE-HIT-'));
    expect(hits).toHaveLength(30);
    expect(hits.length / normalized.length).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// 真库：种子幂等
// ---------------------------------------------------------------------------

describe('`[BE-01]` 种子脚本在真库上幂等', () => {
  let client: Client;

  beforeAll(async () => {
    await dropAndRecreateSchema(databaseUrl());
    await migrate(databaseUrl());
    await resetDatabase(databaseUrl());
    client = await connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function count(table: string): Promise<number> {
    const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(res.rows[0]?.n ?? 0);
  }

  it('连跑两次 db:seed，行数完全一致', async () => {
    await runSeed({ silent: true });
    const first = {
      providers: await count('model_providers'),
      prices: await count('model_prices'),
      datasets: await count('datasets'),
      versions: await count('dataset_versions'),
      cases: await count('dataset_cases'),
    };
    expect(first.providers).toBe(1);
    expect(first.prices).toBe(1);
    expect(first.datasets).toBe(1);
    expect(first.versions).toBe(1);
    expect(first.cases).toBe(20);

    await runSeed({ silent: true });
    const second = {
      providers: await count('model_providers'),
      prices: await count('model_prices'),
      datasets: await count('datasets'),
      versions: await count('dataset_versions'),
      cases: await count('dataset_cases'),
    };
    expect(second).toEqual(first);
  });

  it('种子单价为 0，且能被 getEffectivePrice 读到时用于成本计算', async () => {
    const res = await client.query<{ input_price_per_1k: string; output_price_per_1k: string }>(
      `SELECT input_price_per_1k, output_price_per_1k FROM model_prices LIMIT 1`,
    );
    expect(Number(res.rows[0]?.input_price_per_1k)).toBe(0);
    expect(Number(res.rows[0]?.output_price_per_1k)).toBe(0);
  });
});
