/**
 * 种子脚本（`npm run db:seed`）。
 *
 * 幂等：重复执行的最终状态完全一致，可以随便跑。
 *  - fixture 厂商：`ON CONFLICT (name) DO UPDATE`
 *  - fixture 单价：`effective_from` 固定为过去时刻，`ON CONFLICT` 覆盖
 *  - RAG 基准集：按名称找现有数据集，比对内容指纹，相同则不新建版本
 *
 * 种子只写**两张表**（`model_providers` / `model_prices`）+ 一个演示评测集。
 * 不种 Target、不种 Run：这两样要由页面真实创建，
 * 预置它们等于把「前端能建 Target」这条验收路径绕过去。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb } from '../db/schema/index.js';
import { upsertFixtureProvider } from '../db/repo/modelProviders.js';
import { upsertFixturePrice } from '../db/repo/modelPrices.js';
import { createDataset, createVersion, listDatasets } from '../db/repo/datasets.js';
import { parseJsonl } from '../lib/import/jsonl.js';
import { normalizeCases } from '../lib/import/canonical.js';
import { FIXTURE_PROVIDER } from '../db/seed/fixture-provider.js';
import { FIXTURE_PRICE } from '../db/seed/fixture-price.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(here, '..', 'db', 'seed');
const CREATED_BY = process.env['APP_CREATED_BY'] ?? 'm1-local';

/** 演示评测集名称：重复执行时靠它找回同一个容器，避免每次种子都建新数据集。 */
export const DEMO_DATASET_NAME = 'RAG 基准集（演示用最小集）';

export interface SeedOptions {
  /** 测试里静默执行（不打日志），默认 false。 */
  readonly silent?: boolean;
}

export interface SeedResult {
  readonly providerId: string;
  readonly priceId: string;
  readonly datasetId: string;
  /** `created` = 本次新建了一个版本；`conflict` = 内容未变，未产生新版本。 */
  readonly datasetVersion: 'created' | 'conflict';
  readonly versionNo: number | null;
  readonly caseCount: number;
}

function makeLog(silent: boolean): (msg: string) => void {
  return silent ? () => undefined : (msg) => console.log(msg);
}

async function seedProviderAndPrice(
  log: (msg: string) => void,
): Promise<{ providerId: string; priceId: string }> {
  const providerId = await upsertFixtureProvider({
    name: FIXTURE_PROVIDER.name,
    kind: FIXTURE_PROVIDER.kind,
    baseUrl: FIXTURE_PROVIDER.baseUrl,
    apiKeyCiphertext: FIXTURE_PROVIDER.apiKeyCiphertext,
    apiKeyMasked: FIXTURE_PROVIDER.apiKeyMasked,
    maxConcurrency: FIXTURE_PROVIDER.maxConcurrency,
    isActive: FIXTURE_PROVIDER.isActive,
  });
  log(`  ✓ model_providers：${FIXTURE_PROVIDER.name}`);

  const priceId = await upsertFixturePrice({
    providerId,
    modelId: FIXTURE_PRICE.modelId,
    displayName: FIXTURE_PRICE.displayName,
    inputPricePer1k: FIXTURE_PRICE.inputPricePer1k,
    outputPricePer1k: FIXTURE_PRICE.outputPricePer1k,
    currency: FIXTURE_PRICE.currency,
  });
  log(`  ✓ model_prices：${FIXTURE_PRICE.modelId}（单价 0）`);

  return { providerId, priceId };
}

async function seedDemoDataset(log: (msg: string) => void): Promise<{
  datasetId: string;
  datasetVersion: 'created' | 'conflict';
  versionNo: number | null;
  caseCount: number;
}> {
  const content = await readFile(join(SEED_DIR, 'rag-benchmark.jsonl'), 'utf8');
  const { cases, report } = parseJsonl(content);
  if (!report.canCommit) {
    throw new Error(
      `rag-benchmark.jsonl 未通过校验：ok=${report.okCount} 失败=${report.failedCount}`,
    );
  }

  const existing = (
    await listDatasets({ limit: 200, keyword: DEMO_DATASET_NAME })
  ).find((d) => d.name === DEMO_DATASET_NAME);

  const datasetId =
    existing?.id ??
    (
      await createDataset({
        name: DEMO_DATASET_NAME,
        description: '20 条 RAG 问答样本，覆盖数值保真、grade=0 干扰项与 Recall=0 构造。',
        createdBy: CREATED_BY,
      })
    ).id;

  const result = await createVersion({
    datasetId,
    normalizedCases: normalizeCases(cases),
    source: 'import',
    note: '种子数据',
    createdBy: CREATED_BY,
  });

  if (result.kind === 'conflict') {
    log(`  = 评测集「${DEMO_DATASET_NAME}」内容未变（同 v${result.existingVersionNo}），不新建版本`);
    const existingVersionNo = result.existingVersionNo;
    return {
      datasetId,
      datasetVersion: 'conflict',
      versionNo: existingVersionNo,
      caseCount: cases.length,
    };
  }

  const v = result.version;
  log(`  ✓ dataset v${v.versionNo}：${DEMO_DATASET_NAME}（${v.caseCount} 条）`);
  return {
    datasetId,
    datasetVersion: 'created',
    versionNo: v.versionNo,
    caseCount: v.caseCount,
  };
}

/**
 * 执行种子（可被测试直接调用）。
 *
 * 不提 `closeDb()`：连接池的生命周期由调用方管 —— CLI 会在 `main()` 里关，
 * 测试会共用同一个池跑多条断言。
 */
export async function runSeed(options: SeedOptions = {}): Promise<SeedResult> {
  const log = makeLog(options.silent === true);
  log('[seed] 开始');

  const { providerId, priceId } = await seedProviderAndPrice(log);
  const dataset = await seedDemoDataset(log);

  log('[seed] 完成');
  return { providerId, priceId, ...dataset };
}

async function main(): Promise<void> {
  try {
    await runSeed();
  } finally {
    await closeDb();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('scripts/seed.ts') || process.argv[1].endsWith('scripts\\seed.ts'));

if (isMain) {
  main().catch(async (err: unknown) => {
    console.error('[seed] 失败：', err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
}
