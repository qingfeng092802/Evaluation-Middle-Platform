/**
 * 仓储 · 队列函数（`claim_next_run` / `reclaim_stale_runs`）。
 *
 * M1 **只从数据库侧领取**：worker 不得自己 `SELECT ... WHERE status='PENDING'`
 * 再 `UPDATE`，因为那是「读-改-写」两步，两个 worker 会同时领到同一条。
 * `claim_next_run()` 内部是 `UPDATE ... FOR UPDATE SKIP LOCKED` 单语句完成，
 * 这是 M1 并发正确性的唯一依据。
 */
import { query, queryOne } from './_client.js';

export interface ClaimedRun {
  readonly id: string;
  readonly datasetVersionId: string;
  readonly targetVersionId: string;
  readonly concurrency: number;
  readonly totalCases: number;
}

/** 领取一条 `PENDING` run；没有则返回 `null`。 */
export async function claimNextRun(): Promise<ClaimedRun | null> {
  const row = await queryOne<{
    id: string;
    dataset_version_id: string;
    target_version_id: string;
    concurrency: number;
    total_cases: number;
  }>(`SELECT id, dataset_version_id, target_version_id, concurrency, total_cases
        FROM claim_next_run()`);
  if (!row) return null;
  return {
    id: row.id,
    datasetVersionId: row.dataset_version_id,
    targetVersionId: row.target_version_id,
    concurrency: row.concurrency,
    totalCases: row.total_cases,
  };
}

/**
 * 回收僵尸 run：`RUNNING` 且 `started_at` 早于 `staleAfter` 的退回 `PENDING`。
 *
 * 返回回收条数。这是 `claim_next_run()` 的必然配对——
 * 只领不清，worker 崩溃后那条 run 会永远卡在 `RUNNING`。
 */
export async function reclaimStaleRuns(staleAfter = '10 minutes'): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT reclaim_stale_runs($1::interval)::text AS n`,
    [staleAfter],
  );
  return row ? Number(row.n) : 0;
}

/** 把 run 从 `PENDING` 推到 `RUNNING`（`claim_next_run()` 已完成，此处仅用于自检路径）。 */
export async function markRunStarted(runId: string): Promise<void> {
  await query(`UPDATE eval_runs SET status='RUNNING', started_at=now() WHERE id=$1`, [runId]);
}
