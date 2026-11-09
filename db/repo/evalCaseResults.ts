/**
 * 仓储 · `eval_case_results`（逐条结果，不可变）。
 *
 * 写入前必须过一遍 `EvalCaseResult` 契约的两条 `.refine()`（SPEC-M1 C-3）：
 * 数据库的 `ck_eval_case_results_ok_score` 只单向管「OK ⇒ 有分」，
 * 反向的「非 OK ⇒ 必须无分」只能由契约承担。把校验放在**仓储层**而不是调用点，
 * 是因为这是唯一必经之路——路由、worker、测试都会经过它。
 */
import type { EvalCaseResult } from '@eval-platform/contracts';
import { EvalCaseResult as EvalCaseResultSchema } from '@eval-platform/contracts';
import { iso, num, numOrNull, query, queryOne } from './_client.js';

interface ResultRow {
  id: string;
  eval_run_id: string;
  dataset_case_id: string;
  case_key: string;
  output_text: string | null;
  output_raw: unknown;
  retrieval_returned: unknown;
  status: string;
  error_message: string | null;
  score: string | null;
  passed: boolean | null;
  operator_scores: unknown;
  judge_reasoning: string | null;
  latency_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_target: string;
  cost_judge: string;
  cost_total: string;
  created_at: Date;
  query_summary?: string;
}

const RESULT_SELECT = `
  SELECT r.id, r.eval_run_id, r.dataset_case_id, r.case_key,
         r.output_text, r.output_raw, r.retrieval_returned,
         r.status, r.error_message, r.score, r.passed, r.operator_scores, r.judge_reasoning,
         r.latency_ms, r.tokens_in, r.tokens_out,
         r.cost_target, r.cost_judge, r.cost_total, r.created_at,
         COALESCE(left(dc.input ->> 'query', 40), '') AS query_summary
    FROM eval_case_results r
    LEFT JOIN dataset_cases dc ON dc.id = r.dataset_case_id
`;

function toResult(r: ResultRow): EvalCaseResult {
  return {
    id: r.id,
    evalRunId: r.eval_run_id,
    datasetCaseId: r.dataset_case_id,
    caseKey: r.case_key,
    querySummary: r.query_summary ?? '',
    outputText: r.output_text,
    outputRaw: (r.output_raw ?? null) as EvalCaseResult['outputRaw'],
    retrievalReturned: (r.retrieval_returned ?? null) as EvalCaseResult['retrievalReturned'],
    status: r.status as EvalCaseResult['status'],
    errorMessage: r.error_message,
    score: numOrNull(r.score),
    passed: r.passed,
    operatorScores: (r.operator_scores ?? null) as EvalCaseResult['operatorScores'],
    judgeReasoning: r.judge_reasoning,
    latencyMs: r.latency_ms,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costTarget: num(r.cost_target),
    costJudge: num(r.cost_judge),
    // C-6：生成列，直接读
    costTotal: num(r.cost_total),
    createdAt: iso(r.created_at),
  };
}

export interface CaseResultInsert {
  readonly evalRunId: string;
  readonly datasetCaseId: string;
  readonly caseKey: string;
  readonly outputText: string | null;
  readonly outputRaw: unknown;
  readonly retrievalReturned: unknown;
  readonly status: EvalCaseResult['status'];
  readonly errorMessage: string | null;
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly operatorScores: unknown;
  readonly judgeReasoning: string | null;
  readonly latencyMs: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costTarget: number;
  readonly costJudge: number;
}

/**
 * 写入一条结果。
 *
 * **幂等**：`ON CONFLICT (eval_run_id, case_key) DO NOTHING`。
 * worker 被 SIGKILL 后回收重跑同一 run 时，已写入的 Case 不会重复也不会被改
 * （表本来就不可变，DO UPDATE 会被触发器拒绝）。
 */
export async function insertResult(p: CaseResultInsert): Promise<void> {
  // C-3：写前用契约校验「拼装形状」，两条 refine 都会生效
  EvalCaseResultSchema.parse({
    id: '00000000-0000-0000-0000-000000000000',
    evalRunId: p.evalRunId,
    datasetCaseId: p.datasetCaseId,
    caseKey: p.caseKey,
    querySummary: '',
    outputText: p.outputText,
    outputRaw: (p.outputRaw ?? null) as EvalCaseResult['outputRaw'],
    retrievalReturned: (p.retrievalReturned ?? null) as EvalCaseResult['retrievalReturned'],
    status: p.status,
    errorMessage: p.errorMessage,
    score: p.score,
    passed: p.passed,
    operatorScores: (p.operatorScores ?? null) as EvalCaseResult['operatorScores'],
    judgeReasoning: p.judgeReasoning,
    latencyMs: p.latencyMs,
    tokensIn: p.tokensIn,
    tokensOut: p.tokensOut,
    costTarget: p.costTarget,
    costJudge: p.costJudge,
    costTotal: p.costTarget + p.costJudge,
    createdAt: new Date().toISOString(),
  });

  await query(
    `INSERT INTO eval_case_results
       (eval_run_id, dataset_case_id, case_key, output_text, output_raw, retrieval_returned,
        status, error_message, score, passed, operator_scores, judge_reasoning,
        latency_ms, tokens_in, tokens_out, cost_target, cost_judge)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (eval_run_id, case_key) DO NOTHING`,
    [
      p.evalRunId,
      p.datasetCaseId,
      p.caseKey,
      p.outputText,
      p.outputRaw === null || p.outputRaw === undefined ? null : JSON.stringify(p.outputRaw),
      p.retrievalReturned === null || p.retrievalReturned === undefined
        ? null
        : JSON.stringify(p.retrievalReturned),
      p.status,
      p.errorMessage,
      p.score === null ? null : String(p.score),
      p.passed,
      p.operatorScores === null || p.operatorScores === undefined
        ? null
        : JSON.stringify(p.operatorScores),
      p.judgeReasoning,
      p.latencyMs,
      p.tokensIn,
      p.tokensOut,
      String(p.costTarget),
      String(p.costJudge),
    ],
  );
}

/** 某 run 已写入的 case_key 集合（worker 重跑时跳过已完成的 Case）。 */
export async function listDoneCaseKeys(runId: string): Promise<Set<string>> {
  const rows = await query<{ case_key: string }>(
    `SELECT case_key FROM eval_case_results WHERE eval_run_id = $1`,
    [runId],
  );
  return new Set(rows.map((r) => r.case_key));
}

export async function listResults(opts: {
  runId: string;
  limit: number;
  sortBy: 'score' | 'latency' | 'caseKey';
  order: 'asc' | 'desc';
}): Promise<EvalCaseResult[]> {
  // 排序列来自白名单枚举，不做字符串拼接
  const col =
    opts.sortBy === 'score' ? 'r.score' : opts.sortBy === 'latency' ? 'r.latency_ms' : 'r.case_key';
  const dir = opts.order === 'asc' ? 'ASC' : 'DESC';
  const rows = await query<ResultRow>(
    `${RESULT_SELECT} WHERE r.eval_run_id = $1
      ORDER BY ${col} ${dir} NULLS LAST, r.case_key ASC
      LIMIT $2`,
    [opts.runId, opts.limit],
  );
  return rows.map(toResult);
}

export async function getResultByKey(runId: string, caseKey: string): Promise<EvalCaseResult | null> {
  const row = await queryOne<ResultRow>(
    `${RESULT_SELECT} WHERE r.eval_run_id = $1 AND r.case_key = $2`,
    [runId, caseKey],
  );
  return row ? toResult(row) : null;
}
