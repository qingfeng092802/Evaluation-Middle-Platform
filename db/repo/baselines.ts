/**
 * baselines 仓储（`ED-08`，M3 Batch 1：`US-013` 提名 / resolution 消费）。
 *
 * SQL 只住本文件（SPEC-M1 §1.4 分层）。状态流转的正确性由**数据库**当裁判，
 * 仓储层不重复实现：
 *  - `ux_baselines_one_confirmed`（0012 部分唯一索引）：每集至多一个 CONFIRMED；
 *  - `trg_baselines_guard`（0016）：已裁定（CONFIRMED/REJECTED）的行不可再改，
 *    流转目标只能是 CONFIRMED / REJECTED。
 */
import type { Baseline } from '@eval-platform/contracts';
import { iso, isoOrNull, num, numOrNull, query, queryOne } from './_client.js';

/** baselines 行形状（snake_case，与 0012 DDL 逐字一致）。 */
interface BaselineRow {
  id: string;
  dataset_id: string;
  eval_run_id: string;
  status: string;
  note: string | null;
  nominated_by: string;
  nominated_at: Date | string;
  decided_by: string | null;
  decided_at: Date | string | null;
}

const BASELINE_COLUMNS =
  'id, dataset_id, eval_run_id, status, note, nominated_by, nominated_at, decided_by, decided_at';

function mapBaseline(row: BaselineRow): Baseline {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    evalRunId: row.eval_run_id,
    status: row.status as Baseline['status'],
    note: row.note,
    nominatedBy: row.nominated_by,
    nominatedAt: iso(row.nominated_at),
    decidedBy: row.decided_by,
    decidedAt: isoOrNull(row.decided_at),
  };
}

/** 提名前置上下文：run 是否存在、当前状态、所属评测集（JOIN 版本表取得）。 */
export interface RunNominationContext {
  runId: string;
  datasetId: string;
  status: string;
}

export async function getRunNominationContext(runId: string): Promise<RunNominationContext | null> {
  const row = await queryOne<{ run_id: string; dataset_id: string; status: string }>(
    `SELECT r.id AS run_id, dv.dataset_id, r.status
       FROM eval_runs r
       JOIN dataset_versions dv ON dv.id = r.dataset_version_id
      WHERE r.id = $1`,
    [runId],
  );
  return row ? { runId: row.run_id, datasetId: row.dataset_id, status: row.status } : null;
}

/** 同一 run 是否已提名过（裁定 3：重复提名 → 409）。 */
export async function findBaselineIdByRun(evalRunId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM baselines WHERE eval_run_id = $1`, [
    evalRunId,
  ]);
  return row?.id ?? null;
}

export async function insertBaseline(input: {
  datasetId: string;
  evalRunId: string;
  note: string;
  nominatedBy: string;
}): Promise<Baseline> {
  const row = await queryOne<BaselineRow>(
    `INSERT INTO baselines (dataset_id, eval_run_id, note, nominated_by)
     VALUES ($1, $2, $3, $4)
     RETURNING ${BASELINE_COLUMNS}`,
    [input.datasetId, input.evalRunId, input.note, input.nominatedBy],
  );
  if (!row) throw new Error('INSERT … RETURNING 未返回行');
  return mapBaseline(row);
}

export async function getBaselineRow(id: string): Promise<Baseline | null> {
  const row = await queryOne<BaselineRow>(
    `SELECT ${BASELINE_COLUMNS} FROM baselines WHERE id = $1`,
    [id],
  );
  return row ? mapBaseline(row) : null;
}

/**
 * 确认 / 驳回——**裁定流转由数据库当裁判**，仓储层不重复实现：
 *  - `trg_baselines_guard`：已裁定（CONFIRMED/REJECTED）行再 UPDATE 会 RAISE
 *    （不可 re-decide），`handle()` 把它统一翻译成 409 IMMUTABLE_VIOLATION；
 *  - 确认时同集已有 CONFIRMED → `ux_baselines_one_confirmed` 唯一冲突 → 409 CONFLICT。
 *
 * note 语义（需求方 2026-11-15 裁定 2）：payload 携带 `note` 则覆盖，未携带则
 * 保留原值——提名理由是有价值的上下文，驳回时不该被静默清空。
 */
export async function decideBaseline(input: {
  id: string;
  approve: boolean;
  decidedBy: string;
  note?: string;
}): Promise<Baseline> {
  const status = input.approve ? 'CONFIRMED' : 'REJECTED';
  const params: unknown[] = [input.id, status, input.decidedBy];
  const setNote = input.note === undefined ? '' : ', note = $4';
  if (input.note !== undefined) params.push(input.note);
  const row = await queryOne<BaselineRow>(
    `UPDATE baselines
        SET status = $2, decided_by = $3, decided_at = now()${setNote}
      WHERE id = $1
      RETURNING ${BASELINE_COLUMNS}`,
    params,
  );
  if (!row) throw new Error('UPDATE … RETURNING 未返回行');
  return mapBaseline(row);
}

/**
 * 某评测集的基线解析（`BaselineResolution` 的数据面）。
 * 评测集不存在 → `null`（服务层翻译成 404）；`confirmed` 为 null 是一等状态（契约注释原文）。
 */
export async function getBaselineResolution(
  datasetId: string,
): Promise<{ confirmed: Baseline | null; pendingNominations: number } | null> {
  const exists = await queryOne<{ ok: number }>(`SELECT 1 AS ok FROM datasets WHERE id = $1`, [
    datasetId,
  ]);
  if (!exists) return null;
  const confirmedRow = await queryOne<BaselineRow>(
    `SELECT ${BASELINE_COLUMNS} FROM baselines
      WHERE dataset_id = $1 AND status = 'CONFIRMED'`,
    [datasetId],
  );
  const pending = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM baselines WHERE dataset_id = $1 AND status = 'NOMINATED'`,
    [datasetId],
  );
  return {
    confirmed: confirmedRow ? mapBaseline(confirmedRow) : null,
    pendingNominations: num(pending?.n ?? '0'),
  };
}

export async function datasetExists(id: string): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(`SELECT 1 AS ok FROM datasets WHERE id = $1`, [id]);
  return row !== null;
}

/**
 * 基线列表（PG-09「基线确认」Tab 数据面；openapi `GET /api/baselines` 已先行定义）。
 *
 * `runSummary` 由 JOIN `eval_runs` 一次带出（契约注释：「展示用冗余……避免列表页 N+1 查询」）——
 * Tab 要展示的「运行名」就在这里。`status` 为 null 时不过滤，按提名时间倒序。
 */
export async function listBaselines(
  datasetId: string,
  status: string | null,
): Promise<Baseline[]> {
  const rows = await query<BaselineRow & { run_name: string; score_overall: string | null; pass_rate: string | null; finished_at: Date | string | null }>(
    `SELECT b.id, b.dataset_id, b.eval_run_id, b.status, b.note, b.nominated_by,
            b.nominated_at, b.decided_by, b.decided_at,
            r.name AS run_name, r.score_overall, r.pass_rate, r.finished_at
       FROM baselines b
       JOIN eval_runs r ON r.id = b.eval_run_id
      WHERE b.dataset_id = $1${status === null ? '' : ' AND b.status = $2'}
      ORDER BY b.nominated_at DESC, b.id DESC`,
    status === null ? [datasetId] : [datasetId, status],
  );
  return rows.map((r) => ({
    ...mapBaseline(r),
    runSummary: {
      runName: r.run_name,
      scoreOverall: numOrNull(r.score_overall),
      passRate: numOrNull(r.pass_rate),
      finishedAt: isoOrNull(r.finished_at),
    },
  }));
}
