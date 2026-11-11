/**
 * Worker 主循环（常驻进程，与 app 无共享内存）。
 *
 * 结构刻意保持极薄：领取 → 逐条执行 → 落库 → 终态聚合。
 * 任何业务口径都不在这里新增，全部下沉到 `lib/runner`。
 *
 * 五个必须做对的点：
 *  1. **只从 `claim_next_run()` 领取**，不自己 SELECT+UPDATE（否则两个 worker 领同一条）；
 *  2. **定时 `reclaim_stale_runs()`**，否则崩溃留下的 RUNNING 永远卡住；
 *  3. **处理期间按 `TTL / 3` 续写 `heartbeat_at`**，否则任何耗时超过回收阈值的
 *     **正常** run 都会被当成僵尸抢走、二次调用网关（#6）；
 *  4. **每落一条 Case 就刷新计数字段**，否则运行中进度条永远是 `0 / N`（#1）；
 *  5. `SIGTERM` 时**跑完当前批次再退**，不在写入一半时硬中断。
 */
import pLimit from 'p-limit';
import { claimNextRun, reclaimStaleRuns, touchHeartbeat } from '../db/repo/queue.js';
import {
  finalizeRun,
  getRunDetail,
  isCancelRequested,
  listRunEvaluators,
  refreshRunProgress,
} from '../db/repo/evalRuns.js';
import { listCases } from '../db/repo/datasets.js';
import { getT1ExecutionConfig } from '../db/repo/targets.js';
import { getProviderForExecution } from '../db/repo/modelProviders.js';
import { insertResult, listDoneCaseKeys } from '../db/repo/evalCaseResults.js';
import { executeCase, specFromRunEvaluator } from '../lib/runner/execute-case.js';
import type { PriceSnapshotEntry } from '../lib/cost/index.js';
import { heartbeatIntervalMs, leaseDurationMs } from '../lib/lease/index.js';
import { closeDb } from '../db/schema/index.js';

const CONCURRENCY_DEFAULT = Number(process.env['WORKER_CONCURRENCY'] ?? 4);
const POLL_INTERVAL_MS = Number(process.env['WORKER_POLL_INTERVAL_MS'] ?? 200);
const RECLAIM_INTERVAL_MS = Number(process.env['WORKER_RECLAIM_INTERVAL_MS'] ?? 60_000);
const STALE_AFTER = process.env['WORKER_STALE_AFTER'] ?? '10 minutes';

/**
 * 心跳间隔 = 租约 TTL / 3。TTL 与间隔都从配置派生，不硬编码（#6 方案 A）。
 * 启动即解析：TTL 写错时**在领取任何 run 之前**就失败，而不是跑起来后
 * 「回收阈值其实不是你写的那个值」。
 */
const LEASE_TTL_MS = leaseDurationMs(STALE_AFTER);
const HEARTBEAT_INTERVAL_MS = heartbeatIntervalMs(LEASE_TTL_MS);

let shuttingDown = false;
let lastReclaimAt = 0;

function log(msg: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SnapshotShape {
  priceSnapshot?: PriceSnapshotEntry[];
}

/** 处理一条已领取的 run（状态已由 `claim_next_run()` 置为 RUNNING）。 */
export async function processRun(runId: string): Promise<void> {
  // 领取时 `heartbeat_at` 保持 NULL（由 claim_next_run 决定，不在这里写）：
  // 只有**真正在跑的 worker** 才续约，否则「领了就跑路」也会显得活着。
  const heartbeat = setInterval(() => {
    void touchHeartbeat(runId).catch((err: unknown) => {
      log(`run ${runId} 心跳失败：${(err as Error).message}`);
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const detail = await getRunDetail(runId);
    if (!detail) {
      log(`run ${runId} 不存在，跳过`);
      return;
    }

    if (detail.evaluators.length === 0) {
      log(`run ${runId} 没有算子快照，直接聚合终态`);
      await finalizeRun(runId, false);
      return;
    }

    // 执行期只读 config_snapshot（R-11）
    const priceSnapshot: PriceSnapshotEntry[] =
      (detail.configSnapshot as SnapshotShape | undefined)?.priceSnapshot ?? [];

    const target = await getT1ExecutionConfig(detail.targetVersionId);
    if (!target) throw new Error(`run ${runId} 的目标版本不可执行`);

    const provider = await getProviderForExecution(target.modelProviderId);
    if (!provider) throw new Error(`run ${runId} 的厂商不可用`);

    const [cases, done, evaluatorRows] = await Promise.all([
      listCases(detail.datasetVersionId),
      listDoneCaseKeys(runId),
      listRunEvaluators(runId),
    ]);

    const evaluators = evaluatorRows.map((e) =>
      specFromRunEvaluator({
        evaluatorKey: e.evaluator_key,
        kind: e.kind as 'rule' | 'judge',
        config: e.config,
        weight: Number(e.weight),
        passThreshold: e.pass_threshold === null ? null : Number(e.pass_threshold),
      }),
    );

    const limit = pLimit(Math.max(1, Math.min(detail.concurrency || CONCURRENCY_DEFAULT, 32)));

    const tasks = cases
      .filter((c) => !done.has(c.caseKey)) // 重跑时跳过已写入的 Case（幂等）
      .map((c) =>
        limit(async () => {
          if (shuttingDown) return; // 优雅退出：不再开新 Case
          const outcome = await executeCase({
            runId,
            case: c,
            target,
            provider,
            evaluators,
            priceSnapshot,
          });
          await insertResult({
            evalRunId: runId,
            datasetCaseId: outcome.datasetCaseId,
            caseKey: outcome.caseKey,
            outputText: outcome.outputText,
            outputRaw: outcome.outputRaw,
            retrievalReturned: outcome.retrievalReturned,
            status: outcome.status,
            errorMessage: outcome.errorMessage,
            score: outcome.score,
            passed: outcome.passed,
            operatorScores: outcome.operatorScores,
            judgeReasoning: null,
            latencyMs: outcome.latencyMs,
            tokensIn: outcome.tokensIn,
            tokensOut: outcome.tokensOut,
            costTarget: outcome.costTarget,
            costJudge: 0,
          });
          // 递增刷新进度：否则运行中 `succeeded_cases` 恒为 0，
          // `PG-03` 的进度条整块 UI 等于不存在（`#1` 浏览器验收发现）。
          await refreshRunProgress(runId);
        }),
      );

    await Promise.all(tasks);

    const cancelled = await isCancelRequested(runId);
    const status = await finalizeRun(runId, cancelled);
    log(`run ${runId} 终态 ${status}`);
  } finally {
    // 终态之前必须停掉心跳：终态行被 UPDATE 会触发 `eval_runs_guard`
    // （「row is frozen」），那正是 #6 里被抢占者收尾报错的形态。
    clearInterval(heartbeat);
  }
}

/** 定时僵尸回收。 */
async function maybeReclaim(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastReclaimAt < RECLAIM_INTERVAL_MS) return;
  lastReclaimAt = now;
  try {
    const n = await reclaimStaleRuns(STALE_AFTER);
    if (n > 0) log(`回收僵尸 run ${n} 条`);
  } catch (err) {
    log(`僵尸回收失败：${(err as Error).message}`);
  }
}

export async function runWorker(): Promise<void> {
  log(
    `启动（concurrency=${CONCURRENCY_DEFAULT}, poll=${POLL_INTERVAL_MS}ms, ` +
      `lease=${STALE_AFTER} ⇒ heartbeat=${HEARTBEAT_INTERVAL_MS}ms）`,
  );
  await maybeReclaim(true);

  while (!shuttingDown) {
    try {
      await maybeReclaim();
      const claimed = await claimNextRun();
      if (!claimed) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      log(`领取 run ${claimed.id}（${claimed.totalCases} 条 Case）`);
      await processRun(claimed.id);
    } catch (err) {
      log(`处理失败：${(err as Error).message}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  log('收到退出信号，已结束当前批次');
  await closeDb();
}

/** 注册信号处理（`SIGTERM` / `SIGINT` 均为「跑完当前批再退」）。 */
export function installSignalHandlers(): void {
  const stop = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，将在当前批次结束后退出`);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

/** 供测试复位退出标志。 */
export function resetShutdownFlag(): void {
  shuttingDown = false;
}
