/**
 * 仓储 · 网关调用幂等账本（M2-1，`gateway_idempotency`，迁移 `0019`）。
 *
 * ## 要解决的事
 *
 * worker 真崩溃时，回收方会重跑崩溃瞬间**在途**的 Case。结果行本身是幂等的
 * （`UNIQUE(eval_run_id, case_key)`），但**网关被多调用一次** ⇒ `cost_target`
 * 与实际账单不一致。`cost_target` 是产品承诺的读数，不能只做到「接近」。
 *
 * ## 怎么解决
 *
 * 每次网关调用**之前**先尝试占位幂等键（`reserveGatewayCall`）：
 *  - 占位成功（首次）⇒ 真正调用网关，然后把真实用量写回（`recordGatewayUsage`）；
 *  - 占位失败（已存在）⇒ 说明这条 Case 已被调用过，**直接复用上次的用量**，
 *    不再调用、不再计费。
 *
 * 这就是「同一 Case 的同一类调用只可能成功占位一次」的物理保证 ——
 * 唯一约束在数据库侧，不在应用侧的内存判断里。
 *
 * ## 键的派生
 *
 * `${runId}:${caseKey}:${attemptKind}`。**不存明文 Key**，只存派生值。
 * `attemptKind` 分 `target`（被测模型）/ `judge`（裁判模型），
 * 让「哪一类被重复调用」在账本里可查。
 */
import { query, queryOne } from './_client.js';

/** 调用类别：被测模型 / 裁判模型。 */
export type GatewayAttemptKind = 'target' | 'judge';

/** 幂等键的派生规则（唯一实现处，不得在别处再拼一次）。 */
export function gatewayIdempotencyKey(
  runId: string,
  caseKey: string,
  attemptKind: GatewayAttemptKind,
): string {
  return `${runId}:${caseKey}:${attemptKind}`;
}

export interface GatewayReservation {
  /** `true` = 本次是首次占位，调用方**应当**真正调用网关。 */
  readonly reserved: boolean;
  /** 已存在时（`reserved === false`）的历史用量，调用方直接复用。 */
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * 尝试占位一次网关调用。
 *
 * - 返回 `reserved: true` ⇒ **调用方必须真正调用网关**，随后调用
 *   {@link recordGatewayUsage} 写入真实用量；
 * - 返回 `reserved: false` ⇒ 这条 Case 的这类调用已经发生过，
 *   调用方**不得**再调用网关，直接用返回的用量继续算成本。
 *
 * 实现用 `ON CONFLICT DO NOTHING` + `RETURNING`：一条语句完成「占位或读旧值」，
 * 不存在「先 SELECT 再 INSERT」的竞态窗口（两个 worker 同时进来只会有一个拿到行）。
 */
export async function reserveGatewayCall(
  runId: string,
  caseKey: string,
  attemptKind: GatewayAttemptKind,
): Promise<GatewayReservation> {
  const key = gatewayIdempotencyKey(runId, caseKey, attemptKind);

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO gateway_idempotency (idempotency_key, eval_run_id, case_key, attempt_kind)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
    [key, runId, caseKey, attemptKind],
  );

  if (inserted !== null) {
    // 首次占位：用量尚未写入（等真实调用完再写）。
    return { reserved: true, tokensIn: 0, tokensOut: 0 };
  }

  // 已存在：读回上次的用量快照。若上一次调用写完用量前就崩了，
  // 这里读到 0 —— 调用方据此知道「这次调用没拿到用量」，按 0 计费而不是重调。
  const existing = await queryOne<{ tokens_in: number; tokens_out: number }>(
    `SELECT tokens_in, tokens_out FROM gateway_idempotency WHERE idempotency_key = $1`,
    [key],
  );
  return {
    reserved: false,
    tokensIn: existing?.tokens_in ?? 0,
    tokensOut: existing?.tokens_out ?? 0,
  };
}

/**
 * 把真实用量回填到占位行。
 *
 * **必须在网关调用成功后立即调用**：崩溃后的复用方靠这一行拿到上次的用量。
 * 不写回填的话，复用方读到 0 ⇒ **少计费**，比重复计费更难发现。
 *
 * 账本表有 `gateway_idempotency_usage_once` 触发器：只允许「0 → 实际值」一次，
 * 回填后再改会被数据库拒绝。这不是应用层的约定，是数据库强制的。
 */
export async function recordGatewayUsage(
  runId: string,
  caseKey: string,
  attemptKind: GatewayAttemptKind,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const key = gatewayIdempotencyKey(runId, caseKey, attemptKind);
  await query(
    `UPDATE gateway_idempotency
        SET tokens_in = $2, tokens_out = $3
      WHERE idempotency_key = $1`,
    [key, tokensIn, tokensOut],
  );
}

/** 查询某次 run 是否发生过「重复调用被拦」（用于报告里标注「该 run 发生过回收」）。 */
export async function countReservedCalls(runId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM gateway_idempotency WHERE eval_run_id = $1`,
    [runId],
  );
  return rows[0] === undefined ? 0 : Number(rows[0].n);
}
