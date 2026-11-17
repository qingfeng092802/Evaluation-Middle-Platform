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
import { claimNextRun, reclaimStaleRuns, touchHeartbeat } from '../db/repo/queue.js';
import {
  finalizeRun,
  getRunDetail,
  isCancelRequested,
  listRunEvaluators,
  refreshRunProgress,
} from '../db/repo/evalRuns.js';
import { listCases } from '../db/repo/datasets.js';
import { resolveTargetExecution } from '../db/repo/targets.js';
import { getProviderForExecution } from '../db/repo/modelProviders.js';
import { insertResult, listDoneCaseKeys } from '../db/repo/evalCaseResults.js';
import { executeCase, specFromRunEvaluator } from '../lib/runner/execute-case.js';
import { effectiveConcurrency, providerLimiter } from '../lib/runner/concurrency.js';
import { createJudgeChat } from '../lib/runner/judge-chat.js';
import type { JudgeChat } from '../lib/operators/judge.js';
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

/**
 * 预先为 run 里出现的**每个裁判 (厂商, 模型)** 建好一次模型调用。
 *
 * 为什么不在 `executeCase` 里懒加载：`executeCase` 是同步取 chat 的（它要跑在
 * 一串算子中间），而查厂商是异步的。懒加载会逼出一个「首次返回 null、
 * 第二次才有」的时序陷阱 —— 第一次那条 Case 会被误判成「裁判不可用」。
 * 因此**先全部建好**，再开跑；建不出来的登记成 `null`，让该类 Case 明确 FAILED。
 *
 * 键是 `providerId:modelId` 而非仅 providerId：同一厂商下可以配两个裁判模型
 * （如 5 分制 / 10 分制各一个），只按厂商缓存会把后一个的 model 用错。
 */
async function buildJudgeChatResolver(
  evaluators: readonly { kind: 'rule' | 'judge'; config: unknown }[],
): Promise<(config: { modelProviderId: string; modelId: string }) => JudgeChat | null> {
  const targets = new Map<string, { modelProviderId: string; modelId: string }>();
  for (const e of evaluators) {
    if (e.kind !== 'judge') continue;
    const c = e.config as { modelProviderId: string; modelId: string };
    targets.set(`${c.modelProviderId}:${c.modelId}`, {
      modelProviderId: c.modelProviderId,
      modelId: c.modelId,
    });
  }

  const built = new Map<string, JudgeChat | null>();
  await Promise.all(
    [...targets].map(async ([key, t]) => {
      const provider = await getProviderForExecution(t.modelProviderId);
      built.set(
        key,
        provider === null
          ? null
          : createJudgeChat({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              model: t.modelId,
            }),
      );
    }),
  );

  return (config) => built.get(`${config.modelProviderId}:${config.modelId}`) ?? null;
}

/** 处理一条已领取的 run（状态已由 `claim_next_run()` 置为 RUNNING）。 */
export async function processRun(runId: string, claimEpoch: number): Promise<void> {
  // 领取时 `heartbeat_at` 保持 NULL（由 claim_next_run 决定，不在这里写）：
  // 只有**真正在跑的 worker** 才续约，否则「领了就跑路」也会显得活着。
  //
  // `claimEpoch` 是 M2-3 的 fencing 判据：心跳带 `WHERE claim_epoch = $epoch`。
  // 返回 `false` 表示「我已不是属主」（被回收后别人领走了）——
  // 此时必须**停止续约并放弃该 run**，不得继续写任何结果。
  let lostOwnership = false;
  const heartbeat = setInterval(() => {
    void touchHeartbeat(runId, claimEpoch)
      .then((ok) => {
        if (!ok && !lostOwnership) {
          lostOwnership = true;
          log(`run ${runId} 已不是属主（epoch=${String(claimEpoch)}），停止续约并放弃`);
          clearInterval(heartbeat);
        }
      })
      .catch((err: unknown) => {
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

    const target = await resolveTargetExecution(detail.targetVersionId);
    if (!target) throw new Error(`run ${runId} 的目标版本不可执行`);

    // T1 走网关必须有可用厂商；T2 直连被测端点，不经网关（US-021）。
    const provider =
      target.kind === 't1_prompt' ? await getProviderForExecution(target.modelProviderId) : null;
    if (target.kind === 't1_prompt' && !provider) {
      throw new Error(`run ${runId} 的厂商不可用`);
    }

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

    // 并发度取 min(run.concurrency, provider.max_concurrency)：用户意图（run）
    // 可以被物理上限（厂商）压低，反过来不行。`effConcurrency` 记在日志里，
    // 否则「慢」只会被归因到网关，而真实原因是厂商只给了 2 个并发。
    // T2 无厂商上限，按 run 意图执行。
    const effConcurrency =
      target.kind === 't1_prompt' && provider
        ? effectiveConcurrency({
            runConcurrency: detail.concurrency || CONCURRENCY_DEFAULT,
            providerMaxConcurrency: provider.maxConcurrency,
          })
        : {
            effective: detail.concurrency || CONCURRENCY_DEFAULT,
            runLimit: detail.concurrency || CONCURRENCY_DEFAULT,
            providerLimit: null,
            cappedBy: 'run' as const,
          };
    log(
      `run ${runId} 并发生效值 ${String(effConcurrency.effective)} ` +
        `（run=${String(effConcurrency.runLimit)}，厂商=${String(effConcurrency.providerLimit)}，` +
        `受限于 ${effConcurrency.cappedBy === 'provider' ? '厂商' : 'run'}）`,
    );
    // 闸门按**厂商**共享：同一厂商被两个 run 同时使用时，各自开一个 p-limit
    // 会让厂商看到 2×上限。这里取共享实例，保证进程内单厂商不超发。
    // T2 没有共享厂商，闸门退化为按 run 隔离。
    const limit = providerLimiter(target.kind === 't1_prompt' && provider ? provider.id : `run:${runId}`, effConcurrency.effective);

    const resolveJudgeChat = await buildJudgeChatResolver(evaluators);

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
            resolveJudgeChat,
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
            judgeReasoning: outcome.judgeReasoning,
            latencyMs: outcome.latencyMs,
            tokensIn: outcome.tokensIn,
            tokensOut: outcome.tokensOut,
            costTarget: outcome.costTarget,
            costJudge: outcome.costJudge,
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
      log(`领取 run ${claimed.id}（${claimed.totalCases} 条 Case，epoch=${String(claimed.claimEpoch)}）`);
      await processRun(claimed.id, claimed.claimEpoch);
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
