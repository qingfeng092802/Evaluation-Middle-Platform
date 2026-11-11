/**
 * 真库测试夹具。
 *
 * 这些 helper 直接写 SQL，绕过了 `db/repo/*`；因此**必须自己维持 repo 层的不变量**，
 * 否则测试留下的行会让「声明的计数」与实际行数对不上 —— 这正是 `B-07`/`B-08`：
 * 页面上显示「1 条样本」，实际 `dataset_cases` 里 0 行；Target 显示 `current_version_no=0`
 * 却挂着一个 v1 版本。
 *
 * 不变量由 `tests/support/db-integrity.ts` 统一校验，
 * 回归在 `tests/seed-integrity.spec.ts`。
 */
import { getPool } from '../../db/schema/index.js';
import { dropAndRecreateSchema, migrate, resetDatabase } from '../../db/migrate.js';
import { runSeed } from '../../scripts/seed.js';

export interface PendingRunFixture {
  readonly runId: string;
  readonly datasetId: string;
  readonly datasetVersionId: string;
  readonly providerId: string;
  readonly targetId: string;
  readonly targetVersionId: string;
}

async function oneId(text: string, params: unknown[] = []): Promise<string> {
  const res = await getPool().query<{ id: string }>(text, params);
  const row = res.rows[0];
  if (!row) throw new Error(`期望返回一行：${text}`);
  return row.id;
}

/**
 * 最小可领取的图：数据集版本 → 目标版本 → 一条 PENDING run。
 *
 * **三处必须显式写全**，否则夹具会造出「声明与实际不符」的行（`B-07`/`B-08`）：
 *  - `dataset_cases` 真插一条 —— `case_count=1` 才有对应的行；
 *  - `targets.current_version_no = 1` —— 因为下面真插了 `target_versions` v1；
 *  - `model_providers.base_url` 非空 —— 被 Target 引用的厂商必须可调用。
 *
 * 返回值带上各级 id，供用例断言状态流转；只返回 runId 时调用方无法定位夹具行。
 */
export async function insertPendingRun(name: string): Promise<PendingRunFixture> {
  const datasetId = await oneId(`INSERT INTO datasets (name, owner_id) VALUES ($1, 't') RETURNING id`, [
    name,
  ]);
  const datasetVersionId = await oneId(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1, 1, 1, 'sha256:abc', 'import', 't') RETURNING id`,
    [datasetId],
  );
  // 与 case_count=1 对应：声明一条就必须真有一条
  await oneId(
    `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input, metadata)
     VALUES ($1, $2, 0, '{"query":"fixture"}'::jsonb, '{}'::jsonb) RETURNING id`,
    [datasetVersionId, `case-${name}-0`],
  );
  const providerId = await oneId(
    `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked)
     VALUES ($1, 'openai_compatible', $2, 'fixture-noop', 'fixture-••••noop') RETURNING id`,
    [`mp-${name}`, 'http://127.0.0.1:1/v1'],
  );
  const targetId = await oneId(
    `INSERT INTO targets (name, kind, current_version_no, owner_id)
     VALUES ($1, 't1_prompt', 1, 't') RETURNING id`,
    [`tg-${name}`],
  );
  const targetVersionId = await oneId(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1, 1, 't1_prompt', $2, 'fixture-echo-1', '{{input}}', 0, 64, 't') RETURNING id`,
    [targetId, providerId],
  );
  const runId = await oneId(
    `INSERT INTO eval_runs
       (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
        runner_version, created_by, total_cases, status)
     VALUES ($1, $2, $3, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', 1, 'PENDING') RETURNING id`,
    [`run-${name}`, datasetVersionId, targetVersionId],
  );

  return { runId, datasetId, datasetVersionId, providerId, targetId, targetVersionId };
}

/**
 * 收尾复原种子（`B-07`/`B-08`）。
 *
 * 真库 spec 会在库里留下夹具行：数据集「声明 N 条样本、实际 0 行」、
 * Target「指向 v0、却挂着 v1」、厂商 `base_url` 为 NULL。
 * 只关连接池不清库，残渣就一路留到下一次人工点页面才被发现。
 *
 * 这里把库**还原成只有种子的状态**：下一个 spec 起来看到的库是可预期的，
 * 人工复核时也不会对着上一轮的测试垃圾猜。
 *
 * 注意：调用方必须**先**关掉自己的连接 / 连接池，否则 `DROP SCHEMA` 会被占用阻塞。
 */
export async function restoreSeed(url: string | undefined): Promise<void> {
  await dropAndRecreateSchema(url);
  await migrate(url);
  await resetDatabase(url);
  await runSeed({ silent: true });
}
