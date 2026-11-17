/**
 * compare / diff 仓储（M3 Batch 2）。SQL 唯一住所（SPEC-M1 §1.4 分层）。
 *
 * 性能口径：结果行只按 `WHERE eval_run_id = ANY($1::uuid[])` 取**两个 run 的行**，
 * 命中 `ux_eval_case_results_run_key (eval_run_id, case_key)` 索引，绝不扫全表；
 * case 对齐在服务层内存完成（50-case 量级，Q3 裁定 Batch 2 不分页）。
 */
import { numOrNull, query, queryOne } from './_client.js';

export interface CompareResultRow {
  id: string;
  evalRunId: string;
  caseKey: string;
  status: string;
  score: number | null;
  outputText: string | null;
  /** `[{key,kind,score,…}]` 的 jsonb；FAILED/未执行行为 null。 */
  operatorScores: Array<{ key: string; kind: string; score: number | null }> | null;
}

export async function listResultsByRunIds(
  runIds: readonly [string, string],
): Promise<CompareResultRow[]> {
  const rows = await query<{
    id: string;
    eval_run_id: string;
    case_key: string;
    status: string;
    score: string | null;
    output_text: string | null;
    operator_scores: unknown;
  }>(
    `SELECT id, eval_run_id, case_key, status, score, output_text, operator_scores
       FROM eval_case_results
      WHERE eval_run_id = ANY($1::uuid[])
      ORDER BY case_key`,
    [runIds],
  );
  return rows.map((r) => ({
    id: r.id,
    evalRunId: r.eval_run_id,
    caseKey: r.case_key,
    status: r.status,
    score: numOrNull(r.score),
    outputText: r.output_text,
    operatorScores:
      (r.operator_scores as Array<{ key: string; kind: string; score: number | null }> | null) ??
      null,
  }));
}

export interface EvaluatorOrderRow {
  evalRunId: string;
  evaluatorKey: string;
  kind: 'rule' | 'judge';
  orderIndex: number;
}

export async function listEvaluatorOrderByRunIds(
  runIds: readonly [string, string],
): Promise<EvaluatorOrderRow[]> {
  const rows = await query<{
    eval_run_id: string;
    evaluator_key: string;
    kind: string;
    order_index: number;
  }>(
    `SELECT eval_run_id, evaluator_key, kind, order_index
       FROM run_evaluators
      WHERE eval_run_id = ANY($1::uuid[])
      ORDER BY eval_run_id, order_index`,
    [runIds],
  );
  return rows.map((r) => ({
    evalRunId: r.eval_run_id,
    evaluatorKey: r.evaluator_key,
    kind: r.kind as EvaluatorOrderRow['kind'],
    orderIndex: r.order_index,
  }));
}

/** 已确认基线的 eval_run_id（`BL-2` 判定数据面）；无确认基线 → null（一等状态）。 */
export async function getConfirmedBaselineRunId(datasetVersionId: string): Promise<string | null> {
  const row = await queryOne<{ eval_run_id: string }>(
    `SELECT b.eval_run_id
       FROM baselines b
       JOIN dataset_versions dv ON dv.dataset_id = b.dataset_id
      WHERE dv.id = $1 AND b.status = 'CONFIRMED'`,
    [datasetVersionId],
  );
  return row?.eval_run_id ?? null;
}
