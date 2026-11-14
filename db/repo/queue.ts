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
  /**
   * **Fencing token**（M2-3）。本次领取的代次，`claim_next_run()` 每次 `+1`。
   *
   * worker 必须把它一路带着：心跳、结果写入、终态更新都传 `WHERE claim_epoch = $epoch`。
   * 旧属主（GC 停顿后恢复）拿着过期的 epoch，所有写入影响 0 行 ⇒ 立即放弃。
   */
  readonly claimEpoch: number;
}

/** 领取一条 `PENDING` run；没有则返回 `null`。 */
export async function claimNextRun(): Promise<ClaimedRun | null> {
  const row = await queryOne<{
    id: string;
    dataset_version_id: string;
    target_version_id: string;
    concurrency: number;
    total_cases: number;
    claim_epoch: string;
  }>(`SELECT id, dataset_version_id, target_version_id, concurrency, total_cases, claim_epoch
        FROM claim_next_run()`);
  if (!row) return null;
  return {
    id: row.id,
    datasetVersionId: row.dataset_version_id,
    targetVersionId: row.target_version_id,
    concurrency: row.concurrency,
    totalCases: row.total_cases,
    // `pg` 把 bigint 读成 string，转回 number（epoch 是领取计数，不会溢出）。
    claimEpoch: Number(row.claim_epoch),
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
 *
 * `claimEpoch` 是 **M2-3 的 fencing 判据**：`AND claim_epoch = $2` 让旧属主
 * （GC 停顿后恢复）续不上心跳。返回 `false` 表示「我已不是属主」——
 * 调用方必须**立即放弃该 run**，不得继续写任何结果。
 */
export async function touchHeartbeat(runId: string, claimEpoch: number): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE eval_runs
        SET heartbeat_at = now()
      WHERE id = $1 AND status = 'RUNNING' AND claim_epoch = $2
      RETURNING id`,
    [runId, claimEpoch],
  );
  return row !== null;
}

/**
 * 带 fencing 的终态更新。
 *
 * 与 {@link touchHeartbeat} 同一判据：`claim_epoch` 不匹配 ⇒ 影响 0 行 ⇒ 返回 `false`。
 * worker 收尾时必须先看这个返回值再决定是否继续写 Case 结果。
 */
export async function updateRunWithFence(
  runId: string,
  claimEpoch: number,
  setClause: string,
  params: readonly unknown[],
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE eval_runs SET ${setClause}
      WHERE id = $1 AND claim_epoch = $2
      RETURNING id`,
    [runId, claimEpoch, ...params],
  );
  return row !== null;
}

/** 把 run 从 `PENDING` 推到 `RUNNING`（`claim_next_run()` 已完成，此处仅用于自检路径）。 */
export async function markRunStarted(runId: string): Promise<void> {
  await query(`UPDATE eval_runs SET status='RUNNING', started_at=now() WHERE id=$1`, [runId]);
}
