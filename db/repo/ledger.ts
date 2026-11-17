/**
 * 成本台账聚合仓储（M4 Batch 4，`US-019` 四维，PG-10 数据面）。
 *
 * 两条铁律：
 *  - **numeric 聚合只在 SQL 里做**（TS-2 红线：禁止 node 浮点累加）——
 *    本文件返回的金额全是 numeric 的字符串原样，由调用方一次性 `Number()`；
 *  - **fixture provider 行必须排除**（milestones §5.3 台账口径红线）：判定身份用
 *    种子常量名（`FIXTURE_PROVIDER.name`），由 service 注入——repo 不 import 种子。
 *
 * 维度表达式里 `model` 维的分组键是 `target_versions.model_id`（被测模型）；
 * T2 目标没有模型 ⇒ `external-target`（不冒充任何模型名）。
 */
import { query } from './_client.js';

export interface LedgerRowAgg {
  dimensionKey: string;
  label: string;
  tokensIn: string;
  tokensOut: string;
  costTarget: string;
  costJudge: string;
  costTotal: string;
  runCount: number;
  unknownCostCases: number;
}

export interface LedgerAggregates {
  /** 全窗总计行（G5 的「汇总卡」）。 */
  summary: LedgerRowAgg;
  /** 分组明细行，按 costTotal 降序。 */
  rows: LedgerRowAgg[];
}

const DIM_KEY = `CASE $4::text
    WHEN 'time'    THEN to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    WHEN 'model'   THEN COALESCE(b.model_id, 'external-target')
    WHEN 'dataset' THEN b.dataset_id::text
    ELSE b.created_by
  END`;

const DIM_LABEL = `CASE $4::text
    WHEN 'time'    THEN to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    WHEN 'model'   THEN COALESCE(b.model_id, '外部 HTTP 目标（T2）')
    WHEN 'dataset' THEN b.dataset_name
    ELSE b.created_by
  END`;

const SQL = `
WITH base AS (
  SELECT r.id, r.created_at, r.created_by, r.tokens_in_total, r.tokens_out_total,
         r.cost_target, r.cost_judge, r.cost_total,
         dv.dataset_id, d.name AS dataset_name, tv.kind AS tv_kind, tv.model_id
    FROM eval_runs r
    JOIN dataset_versions dv ON dv.id = r.dataset_version_id
    JOIN datasets d ON d.id = dv.dataset_id
    LEFT JOIN target_versions tv ON tv.id = r.target_version_id
    LEFT JOIN model_providers p ON p.id = tv.model_provider_id
   WHERE r.created_at >= $1::timestamptz AND r.created_at <= $2::timestamptz
     AND (p.id IS NULL OR p.name <> $3)
),
unknown AS (
  -- US-021：T2 目标的 OK case 且两端 usage 全 0 ⇒ 端点未回传用量，成本语义是 unknown
  SELECT b.id AS run_id, count(*)::int AS n
    FROM eval_case_results cr
    JOIN base b ON b.id = cr.eval_run_id
   WHERE cr.status = 'OK' AND b.tv_kind = 't2_http'
     AND cr.tokens_in = 0 AND cr.tokens_out = 0
   GROUP BY b.id
),
enriched AS (
  SELECT b.*, ${DIM_KEY} AS dimension_key, ${DIM_LABEL} AS label, COALESCE(u.n, 0) AS unknown_n
    FROM base b
    LEFT JOIN unknown u ON u.run_id = b.id
)
SELECT dimension_key, label,
       COALESCE(SUM(tokens_in_total), 0)::text  AS tokens_in,
       COALESCE(SUM(tokens_out_total), 0)::text AS tokens_out,
       COALESCE(SUM(cost_target), 0)::text      AS cost_target,
       COALESCE(SUM(cost_judge), 0)::text       AS cost_judge,
       COALESCE(SUM(cost_total), 0)::text       AS cost_total,
       COUNT(DISTINCT id)::int                  AS run_count,
       COALESCE(SUM(unknown_n), 0)::int         AS unknown_cases
  FROM enriched
 GROUP BY GROUPING SETS ((dimension_key, label), ())
 ORDER BY cost_total DESC`;

interface RawRow {
  dimension_key: string | null;
  label: string | null;
  tokens_in: string;
  tokens_out: string;
  cost_target: string;
  cost_judge: string;
  cost_total: string;
  run_count: number;
  unknown_cases: number;
}

function toAgg(r: RawRow): LedgerRowAgg {
  return {
    dimensionKey: r.dimension_key ?? '',
    label: r.label ?? '',
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costTarget: r.cost_target,
    costJudge: r.cost_judge,
    costTotal: r.cost_total,
    runCount: r.run_count,
    unknownCostCases: r.unknown_cases,
  };
}

export async function aggregateLedger(input: {
  from: string;
  to: string;
  dimension: 'time' | 'model' | 'dataset' | 'user';
  fixtureProviderName: string;
}): Promise<LedgerAggregates> {
  const rows = await query<RawRow>(SQL, [input.from, input.to, input.fixtureProviderName, input.dimension]);
  // GROUPING SETS 的总计行：非聚合列全部为 NULL（正常分组的 key 经 COALESCE 不会是 NULL）
  const total = rows.find((r) => r.dimension_key === null);
  const grouped = rows.filter((r) => r.dimension_key !== null);
  if (!total) throw new Error('台账聚合未返回总计行');
  return { summary: toAgg(total), rows: grouped.map(toAgg) };
}
