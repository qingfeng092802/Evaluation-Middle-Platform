/**
 * 对比世界夹具（M3 Batch 2）：同一 `dataset_version` 下两个 COMPLETED run，
 * per-case / per-operator 分数与 run 级指标全部可控。
 *
 * 与 `fixtures.ts` 同法：真库直写 SQL、自己维持不变量
 * （`ck_eval_case_results_ok_score`：OK ⇒ 必有分；非 OK ⇒ 必无分）。
 * run 状态按 `trg_eval_runs_guard` 的合法流转推进（PENDING→RUNNING→COMPLETED）。
 */
import { getPool } from '../../db/schema/index.js';

export interface OperatorScoreSpec {
  key: string;
  kind: 'rule' | 'judge';
  score: number | null;
}

export interface CaseResultSpec {
  caseKey: string;
  status?: 'OK' | 'FAILED' | 'SKIPPED';
  /** OK 行必填（DB 约束）；非 OK 行强制 null。 */
  score?: number | null;
  outputText?: string | null;
  latencyMs?: number;
  operatorScores?: OperatorScoreSpec[];
}

export interface CompareRunSpec {
  name: string;
  evaluators: Array<{ key: string; kind: 'rule' | 'judge'; orderIndex: number }>;
  cases: CaseResultSpec[];
  metrics?: {
    scoreOverall?: number | null;
    passRate?: number | null;
    coverage?: number | null;
    latencyP50?: number | null;
    latencyP95?: number | null;
    costTarget?: number;
  };
}

export interface CompareWorld {
  datasetId: string;
  datasetVersionId: string;
  baselineRunId: string;
  currentRunId: string;
  caseIds: Map<string, string>;
}

async function one(text: string, params: unknown[] = []): Promise<string> {
  const res = await getPool().query<{ id: string }>(text, params);
  const row = res.rows[0];
  if (!row) throw new Error(`夹具期望一行：${text}`);
  return row.id;
}

export async function buildCompareWorld(spec: {
  name: string;
  baseline: CompareRunSpec;
  current: CompareRunSpec;
}): Promise<CompareWorld> {
  const datasetId = await one(`INSERT INTO datasets (name, owner_id) VALUES ($1, 't') RETURNING id`, [
    `cmp-${spec.name}`,
  ]);
  const caseKeys = [
    ...new Set([...spec.baseline.cases.map((c) => c.caseKey), ...spec.current.cases.map((c) => c.caseKey)]),
  ];
  const datasetVersionId = await one(
    `INSERT INTO dataset_versions (dataset_id, version_no, case_count, content_hash, source, created_by)
     VALUES ($1, 1, $2, $3, 'import', 't') RETURNING id`,
    [datasetId, caseKeys.length, `sha256:cmp-${spec.name}`],
  );
  const caseIds = new Map<string, string>();
  for (let i = 0; i < caseKeys.length; i++) {
    const caseKey = caseKeys[i];
    if (caseKey === undefined) throw new Error(`caseKeys[${i}] 缺失`);
    caseIds.set(
      caseKey,
      await one(
        `INSERT INTO dataset_cases (dataset_version_id, case_key, seq, input, metadata)
         VALUES ($1, $2, $3, '{"query":"fixture"}'::jsonb, '{}'::jsonb) RETURNING id`,
        [datasetVersionId, caseKey, i],
      ),
    );
  }
  const providerId = await one(
    `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked)
     VALUES ($1, 'openai_compatible', 'http://127.0.0.1:1/v1', 'fixture-noop', 'fixture-••••noop') RETURNING id`,
    [`mp-${spec.name}`],
  );
  const targetId = await one(
    `INSERT INTO targets (name, kind, current_version_no, owner_id) VALUES ($1, 't1_prompt', 1, 't') RETURNING id`,
    [`tg-${spec.name}`],
  );
  const targetVersionId = await one(
    `INSERT INTO target_versions
       (target_id, version_no, kind, model_provider_id, model_id, prompt_template, temperature, max_tokens, created_by)
     VALUES ($1, 1, 't1_prompt', $2, 'fixture-echo-1', '{{input}}', 0, 64, 't') RETURNING id`,
    [targetId, providerId],
  );

  async function createRun(rs: CompareRunSpec): Promise<string> {
    const runId = await one(
      `INSERT INTO eval_runs
         (name, dataset_version_id, target_version_id, concurrency, config_snapshot, reproducibility,
          runner_version, created_by, total_cases, status)
       VALUES ($1, $2, $3, 4, '{}'::jsonb, '{}'::jsonb, 'test', 't', $4, 'PENDING') RETURNING id`,
      [rs.name, datasetVersionId, targetVersionId, rs.cases.length],
    );
    await getPool().query(`UPDATE eval_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [runId]);
    const m = rs.metrics ?? {};
    await getPool().query(
      `UPDATE eval_runs
          SET status = 'COMPLETED', finished_at = now(), score_overall = $2, pass_rate = $3,
              coverage = $4, latency_p50_ms = $5, latency_p95_ms = $6, cost_target = $7
        WHERE id = $1`,
      [runId, m.scoreOverall ?? null, m.passRate ?? null, m.coverage ?? null, m.latencyP50 ?? null, m.latencyP95 ?? null, m.costTarget ?? 0],
    );
    for (const ev of rs.evaluators) {
      await one(
        `INSERT INTO run_evaluators (eval_run_id, evaluator_key, evaluator_version, kind, config, weight, pass_threshold, order_index)
         VALUES ($1, $2, 1, $3, '{}'::jsonb, 1, NULL, $4) RETURNING id`,
        [runId, ev.key, ev.kind, ev.orderIndex],
      );
    }
    for (const c of rs.cases) {
      const status = c.status ?? 'OK';
      const datasetCaseId = caseIds.get(c.caseKey);
      if (!datasetCaseId) throw new Error(`case ${c.caseKey} 不在本版本里`);
      const score = status === 'OK' ? (c.score ?? null) : null;
      if (status === 'OK' && score === null) throw new Error(`OK 行必须给分：${c.caseKey}`);
      const opScores = (c.operatorScores ?? []).map((o) => ({
        key: o.key,
        kind: o.kind,
        score: o.score,
        passed: o.score === null ? null : o.score >= 0.6,
        threshold: null,
        weight: 1,
      }));
      await one(
        `INSERT INTO eval_case_results
           (eval_run_id, dataset_case_id, case_key, output_text, status, score, operator_scores, latency_ms, tokens_in, tokens_out, cost_target)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 0, 0, 0) RETURNING id`,
        [
          runId,
          datasetCaseId,
          c.caseKey,
          c.outputText ?? `out-${c.caseKey}`,
          status,
          score,
          status === 'OK' ? JSON.stringify(opScores) : null,
          c.latencyMs ?? null,
        ],
      );
    }
    return runId;
  }

  const baselineRunId = await createRun({ ...spec.baseline, name: `base-${spec.baseline.name}` });
  const currentRunId = await createRun({ ...spec.current, name: `cur-${spec.current.name}` });
  return { datasetId, datasetVersionId, baselineRunId, currentRunId, caseIds };
}

/** 直接插入一条 CONFIRMED 基线（banner 三态测试用；decision 路由不属本批）。 */
export async function insertConfirmedBaseline(datasetId: string, evalRunId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO baselines (dataset_id, eval_run_id, status, note, nominated_by, decided_by, decided_at)
     VALUES ($1, $2, 'CONFIRMED', 'x', 'local', 'local', now())`,
    [datasetId, evalRunId],
  );
}
