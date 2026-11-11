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
 * 回收僵尸 run：判据是**最近一次活动时间**
 * `GREATEST(started_at, heartbeat_at) < now() - staleAfter`。
 *
 * `heartbeat_at` 为 NULL（旧行 / 刚领取尚未心跳）时回退到 `started_at`，
 * 因此 0017 时代的既有语义不变；worker 存活期间由 {@link touchHeartbeat}
 * 续期，长时间正常的 run 不会被误回收（#6）。
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

/**
 * 续写心跳（租约续期）。worker 在处理期间按 `TTL / 3` 的间隔调用。
 *
 * `AND status = 'RUNNING'` 不只是防御：终态行被任何 UPDATE 碰到都会触发
 * `eval_runs_guard` 抛「row is frozen」；加上这个条件后，回收/终态竞态下
 * 心跳只会影响 0 行，不会把一条正常收尾变成错误日志。
 */
export async function touchHeartbeat(runId: string): Promise<void> {
  await query(`UPDATE eval_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'RUNNING'`, [
    runId,
  ]);
}

/** 把 run 从 `PENDING` 推到 `RUNNING`（`claim_next_run()` 已完成，此处仅用于自检路径）。 */
export async function markRunStarted(runId: string): Promise<void> {
  await query(`UPDATE eval_runs SET status='RUNNING', started_at=now() WHERE id=$1`, [runId]);
}
