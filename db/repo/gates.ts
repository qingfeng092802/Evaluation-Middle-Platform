/**
 * regression_gates / gate_evaluations 仓储（M4 Batch 2，`US-017` 数据面）。
 *
 * SQL 唯一住所（SPEC-M1 §1.4 分层）。两条数据库铁律由**数据库**当裁判：
 *  - `gate_evaluations` 走 `reject_mutation()`——留痕一经写入不可 UPDATE/DELETE；
 *  - `regression_gates` 可编辑（规则本身），但判定留痕拆到 0014，各自单纯。
 * 幂等：同 (gate_id, eval_run_id) 的留痕由仓储层查重后跳过插入（0014 无唯一约束）。
 */
import { GateCondition, GateChannel } from '@eval-platform/contracts';
import type { RegressionGate } from '@eval-platform/contracts';
import { iso, query, queryOne } from './_client.js';

interface GateRow {
  id: string;
  name: string;
  dataset_id: string;
  target_id: string | null;
  baseline_id: string | null;
  condition: unknown;
  action: string;
  is_active: boolean;
  channels: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const GATE_COLUMNS =
  'id, name, dataset_id, target_id, baseline_id, condition, action, is_active, channels, created_by, created_at, updated_at';

function mapGate(row: GateRow): RegressionGate {
  return {
    id: row.id,
    name: row.name,
    datasetId: row.dataset_id,
    targetId: row.target_id,
    baselineId: row.baseline_id,
    condition: GateCondition.parse(row.condition),
    action: row.action as RegressionGate['action'],
    isActive: row.is_active,
    channels: GateChannel.array().parse(row.channels ?? []),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface CreateGateInput {
  name: string;
  datasetId: string;
  targetId: string | null;
  baselineId: string | null;
  condition: unknown;
  action: string;
  channels: unknown[];
  createdBy: string;
}

export async function createGate(input: CreateGateInput): Promise<RegressionGate> {
  const row = await queryOne<GateRow>(
    `INSERT INTO regression_gates (name, dataset_id, target_id, baseline_id, condition, action, is_active, channels, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, true, $7::jsonb, $8)
     RETURNING ${GATE_COLUMNS}`,
    [
      input.name,
      input.datasetId,
      input.targetId,
      input.baselineId,
      JSON.stringify(input.condition),
      input.action,
      JSON.stringify(input.channels),
      input.createdBy,
    ],
  );
  if (!row) throw new Error('INSERT … RETURNING 未返回行');
  return mapGate(row);
}

export async function getGateRow(id: string): Promise<RegressionGate | null> {
  const row = await queryOne<GateRow>(`SELECT ${GATE_COLUMNS} FROM regression_gates WHERE id = $1`, [id]);
  return row ? mapGate(row) : null;
}

export async function listGatesByDataset(datasetId: string): Promise<RegressionGate[]> {
  const rows = await query<GateRow>(
    `SELECT ${GATE_COLUMNS} FROM regression_gates WHERE dataset_id = $1 ORDER BY created_at`,
    [datasetId],
  );
  return rows.map(mapGate);
}

export interface UpdateGatePatch {
  name?: string;
  condition?: unknown;
  action?: string;
  isActive?: boolean;
  channels?: unknown[];
}

export async function updateGate(id: string, patch: UpdateGatePatch): Promise<RegressionGate | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [id];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.condition !== undefined) {
    params.push(JSON.stringify(patch.condition));
    sets.push(`condition = $${params.length}::jsonb`);
  }
  if (patch.action !== undefined) {
    params.push(patch.action);
    sets.push(`action = $${params.length}`);
  }
  if (patch.isActive !== undefined) {
    params.push(patch.isActive);
    sets.push(`is_active = $${params.length}`);
  }
  if (patch.channels !== undefined) {
    params.push(JSON.stringify(patch.channels));
    sets.push(`channels = $${params.length}::jsonb`);
  }
  const row = await queryOne<GateRow>(
    `UPDATE regression_gates SET ${sets.join(', ')} WHERE id = $1 RETURNING ${GATE_COLUMNS}`,
    params,
  );
  return row ? mapGate(row) : null;
}

/** 某 dataset version 所属评测集的全部启用规则（判定引擎的规则来源）。
 *  ⚠️ JOIN 下 GATE_COLUMNS 必须逐列限定（`id` 两表同名，裸列名会 ambiguous）。 */
export async function listActiveGatesForDatasetVersion(datasetVersionId: string): Promise<RegressionGate[]> {
  const rows = await query<GateRow>(
    `SELECT g.id, g.name, g.dataset_id, g.target_id, g.baseline_id, g.condition, g.action,
            g.is_active, g.channels, g.created_by, g.created_at, g.updated_at
       FROM regression_gates g
       JOIN dataset_versions dv ON dv.dataset_id = g.dataset_id
      WHERE dv.id = $1 AND g.is_active = true
      ORDER BY g.created_at`,
    [datasetVersionId],
  );
  return rows.map(mapGate);
}

// ---------------------------------------------------------------------------
// gate_evaluations（留痕，不可变）
// ---------------------------------------------------------------------------

export interface GateEvaluationRow {
  id: string;
  gateId: string;
  evalRunId: string;
  passed: boolean;
  metric: string;
  baselineValue: number | null;
  currentValue: number | null;
  delta: number | null;
  op: string;
  value: number;
  createdAt: string;
}

function mapEvaluation(row: {
  id: string;
  gate_id: string;
  eval_run_id: string;
  passed: boolean;
  detail: {
    metric: string;
    baselineValue: string | number | null;
    currentValue: string | number | null;
    delta: string | number | null;
    op: string;
    value: string | number;
  } | null;
  created_at: Date | string;
}): GateEvaluationRow {
  const n = (v: string | number | null): number | null => (v === null ? null : Number(v));
  // detail 的键是 camelCase（写入侧 JSON.stringify 的对象），直接按对象读取
  const d = row.detail ?? { metric: '', baselineValue: null, currentValue: null, delta: null, op: '<', value: 0 };
  return {
    id: row.id,
    gateId: row.gate_id,
    evalRunId: row.eval_run_id,
    passed: row.passed,
    metric: d.metric,
    baselineValue: n(d.baselineValue),
    currentValue: n(d.currentValue),
    delta: n(d.delta),
    op: d.op,
    value: Number(d.value),
    createdAt: iso(row.created_at),
  };
}

export async function hasEvaluation(gateId: string, evalRunId: string): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok FROM gate_evaluations WHERE gate_id = $1 AND eval_run_id = $2`,
    [gateId, evalRunId],
  );
  return row !== null;
}

export async function insertGateEvaluation(input: {
  gateId: string;
  evalRunId: string;
  passed: boolean;
  metric: string;
  baselineValue: number | null;
  currentValue: number | null;
  delta: number | null;
  op: string;
  value: number;
}): Promise<GateEvaluationRow> {
  const row = await queryOne<{
    id: string;
    gate_id: string;
    eval_run_id: string;
    passed: boolean;
    detail: {
      metric: string;
      baselineValue: string | number | null;
      currentValue: string | number | null;
      delta: string | number | null;
      op: string;
      value: string | number;
    };
    created_at: Date | string;
  }>(
    `INSERT INTO gate_evaluations (gate_id, eval_run_id, passed, detail)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, gate_id, eval_run_id, passed, detail, created_at`,
    [
      input.gateId,
      input.evalRunId,
      input.passed,
      JSON.stringify({
        metric: input.metric,
        baselineValue: input.baselineValue,
        currentValue: input.currentValue,
        delta: input.delta,
        op: input.op,
        value: input.value,
      }),
    ],
  );
  if (!row) throw new Error('INSERT … RETURNING 未返回行');
  return mapEvaluation(row);
}

export async function listEvaluationsByRun(evalRunId: string): Promise<GateEvaluationRow[]> {
  const rows = await query<{
    id: string;
    gate_id: string;
    eval_run_id: string;
    passed: boolean;
    detail: {
      metric: string;
      baselineValue: string | number | null;
      currentValue: string | number | null;
      delta: string | number | null;
      op: string;
      value: string | number;
    };
    created_at: Date | string;
  }>(
    `SELECT id, gate_id, eval_run_id, passed, detail, created_at
       FROM gate_evaluations
      WHERE eval_run_id = $1
      ORDER BY created_at`,
    [evalRunId],
  );
  return rows.map(mapEvaluation);
}

/** 已确认基线的 eval_run_id（`BL-2` 唯一锚点）；无确认基线 → null。 */
export async function getConfirmedBaselineEvalRunId(datasetId: string): Promise<string | null> {
  const row = await queryOne<{ eval_run_id: string }>(
    `SELECT eval_run_id FROM baselines WHERE dataset_id = $1 AND status = 'CONFIRMED'`,
    [datasetId],
  );
  return row?.eval_run_id ?? null;
}

/** 判定引擎的上下文：版本所属评测集 id 与目标 id（envelope.datasetId/targetId 需要）。 */
export async function getVersionContext(
  datasetVersionId: string,
): Promise<{ datasetId: string; targetId: string | null } | null> {
  const row = await queryOne<{ dataset_id: string; target_id: string | null }>(
    `SELECT dv.dataset_id, tv.target_id
       FROM dataset_versions dv
       LEFT JOIN target_versions tv ON tv.id = (SELECT target_version_id FROM eval_runs WHERE dataset_version_id = dv.id LIMIT 1)
      WHERE dv.id = $1`,
    [datasetVersionId],
  );
  return row ? { datasetId: row.dataset_id, targetId: row.target_id } : null;
}

// ---------------------------------------------------------------------------
// callback_tokens（CI 回调 Token，M4 Batch 3；明文不落库，仅 SHA-256 哈希）
// ---------------------------------------------------------------------------

export interface CallbackTokenContext {
  gateId: string;
  datasetId: string;
  expiresAt: Date | null;
}

export async function createCallbackToken(input: {
  gateId: string;
  tokenHash: string;
  createdBy: string;
}): Promise<void> {
  await query(
    `INSERT INTO callback_tokens (gate_id, token_hash, created_by)
     VALUES ($1, $2, $3)`,
    [input.gateId, input.tokenHash, input.createdBy],
  );
}

/** 哈希反查明细（JOIN 门禁取评测集 id 供越权校验）；过期行视为不存在。 */
export async function findActiveCallbackToken(tokenHash: string): Promise<CallbackTokenContext | null> {
  const row = await queryOne<{ gate_id: string; dataset_id: string; expires_at: Date | string | null }>(
    `SELECT t.gate_id, g.dataset_id, t.expires_at
       FROM callback_tokens t
       JOIN regression_gates g ON g.id = t.gate_id
      WHERE t.token_hash = $1
        AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [tokenHash],
  );
  return row ? { gateId: row.gate_id, datasetId: row.dataset_id, expiresAt: row.expires_at ? new Date(row.expires_at) : null } : null;
}

/** 某 run 所属评测集 id（拉取鉴权的越权校验需要）。 */
export async function getDatasetIdForRun(runId: string): Promise<string | null> {
  const row = await queryOne<{ dataset_id: string }>(
    `SELECT dv.dataset_id
       FROM eval_runs r
       JOIN dataset_versions dv ON dv.id = r.dataset_version_id
      WHERE r.id = $1`,
    [runId],
  );
  return row?.dataset_id ?? null;
}
