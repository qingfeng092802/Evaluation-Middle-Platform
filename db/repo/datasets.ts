/**
 * 仓储 · `datasets` / `dataset_versions` / `dataset_cases`。
 *
 * 三个不可协商点：
 *  1. **一次导入 = 一个新版本**，且写在**单一事务**里 —— 半套数据（版本行有了、case 没有）
 *     比直接失败更糟，它会让「版本预览 0 条」看起来像是正常业务结果；
 *  2. **内容指纹相同 ⇒ 不产生新版本**（SPEC-M1 R-4），返回 `conflict` 而不是抛错，
 *     让路由层能带着 `existingVersionNo` 组装 409；
 *  3. `dataset_versions` / `dataset_cases` 是不可变表，**本文件不提供任何 UPDATE**。
 *     连"改个 note"都没有入口 —— 没有函数比有函数更容易守住红线。
 */
import type {
  Dataset,
  DatasetCase,
  DatasetVersion,
  RetrievalReadiness,
} from '@eval-platform/contracts';
import type { PoolClient } from 'pg';
import type { NormalizedCase } from '../canonical.js';
import { computeContentHash } from '../canonical.js';
import { iso, isUniqueViolation, query, queryOne, withTransaction } from './_client.js';

// ---------------------------------------------------------------------------
// 读取视图
// ---------------------------------------------------------------------------

interface DatasetRow {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
  latest_version_no: number | null;
  case_count: number | null;
  latest_source: string | null;
}

const DATASET_SELECT = `
  SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
         lv.version_no AS latest_version_no,
         lv.case_count AS case_count,
         lv.source AS latest_source
    FROM datasets d
    LEFT JOIN LATERAL (
      SELECT version_no, case_count, source
        FROM dataset_versions
       WHERE dataset_id = d.id
       ORDER BY version_no DESC
       LIMIT 1
    ) lv ON true
`;

function toDataset(r: DatasetRow): Dataset {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    latestVersionNo: r.latest_version_no,
    caseCount: r.case_count,
    latestSource: (r.latest_source ?? null) as Dataset['latestSource'],
  };
}

export async function listDatasets(opts: {
  limit: number;
  keyword?: string | undefined;
}): Promise<Dataset[]> {
  const rows = await query<DatasetRow>(
    `${DATASET_SELECT}
      WHERE ($2::text IS NULL OR d.name ILIKE '%' || $2 || '%')
      ORDER BY d.created_at DESC
      LIMIT $1`,
    [opts.limit, opts.keyword ?? null],
  );
  return rows.map(toDataset);
}

export async function getDataset(id: string): Promise<Dataset | null> {
  const row = await queryOne<DatasetRow>(`${DATASET_SELECT} WHERE d.id = $1`, [id]);
  return row ? toDataset(row) : null;
}

export async function createDataset(p: {
  name: string;
  description?: string | undefined;
  createdBy: string;
}): Promise<Dataset> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO datasets (name, description, owner_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [p.name, p.description ?? null, p.createdBy],
  );
  if (!row) throw new Error('createDataset 未返回 id');
  const created = await getDataset(row.id);
  if (!created) throw new Error('createDataset 后读取失败');
  return created;
}

/** 仅容器元数据可变（`DatasetUpdate` 的边界）。条目与版本号无更新入口。 */
export async function updateDataset(
  id: string,
  p: { name?: string | undefined; description?: string | null | undefined },
): Promise<Dataset | null> {
  await query(
    `UPDATE datasets
        SET name = COALESCE($2, name),
            description = CASE WHEN $3::boolean THEN $4::text ELSE description END,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      p.name ?? null,
      p.description !== undefined,
      p.description === undefined ? null : p.description,
    ],
  );
  return getDataset(id);
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

interface VersionRow {
  id: string;
  dataset_id: string;
  version_no: number;
  schema_version: string;
  case_count: number;
  content_hash: string;
  source: string;
  note: string | null;
  created_by: string;
  created_at: Date;
}

const VERSION_COLUMNS = `id, dataset_id, version_no, schema_version, case_count,
  content_hash, source, note, created_by, created_at`;

function toVersion(r: VersionRow): DatasetVersion {
  return {
    id: r.id,
    datasetId: r.dataset_id,
    versionNo: r.version_no,
    schemaVersion: '1',
    caseCount: r.case_count,
    contentHash: r.content_hash,
    source: r.source as DatasetVersion['source'],
    note: r.note,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
  };
}

export async function listVersions(datasetId: string): Promise<DatasetVersion[]> {
  const rows = await query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM dataset_versions
      WHERE dataset_id = $1 ORDER BY version_no DESC`,
    [datasetId],
  );
  return rows.map(toVersion);
}

export async function getVersionByNo(
  datasetId: string,
  versionNo: number,
): Promise<DatasetVersion | null> {
  const row = await queryOne<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM dataset_versions
      WHERE dataset_id = $1 AND version_no = $2`,
    [datasetId, versionNo],
  );
  return row ? toVersion(row) : null;
}

export async function getVersionById(versionId: string): Promise<DatasetVersion | null> {
  const row = await queryOne<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM dataset_versions WHERE id = $1`,
    [versionId],
  );
  return row ? toVersion(row) : null;
}

interface CaseRow {
  id: string;
  dataset_version_id: string;
  case_key: string;
  seq: number;
  input: unknown;
  reference: unknown;
  retrieval: unknown;
  metadata: unknown;
  created_at: Date;
}

const CASE_COLUMNS = `id, dataset_version_id, case_key, seq, input, reference, retrieval, metadata, created_at`;

function toCase(r: CaseRow): DatasetCase {
  return {
    id: r.id,
    datasetVersionId: r.dataset_version_id,
    caseKey: r.case_key,
    seq: r.seq,
    input: r.input as DatasetCase['input'],
    reference: (r.reference ?? null) as DatasetCase['reference'],
    retrieval: (r.retrieval ?? null) as DatasetCase['retrieval'],
    metadata: (r.metadata ?? {}) as DatasetCase['metadata'],
    createdAt: iso(r.created_at),
  };
}

/** 版本内全部 Case，按 `seq` 升序（= `case_key` 升序，R-2）。 */
export async function listCases(versionId: string): Promise<DatasetCase[]> {
  const rows = await query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM dataset_cases
      WHERE dataset_version_id = $1 ORDER BY seq ASC`,
    [versionId],
  );
  return rows.map(toCase);
}

export async function getCase(datasetCaseId: string): Promise<DatasetCase | null> {
  const row = await queryOne<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM dataset_cases WHERE id = $1`,
    [datasetCaseId],
  );
  return row ? toCase(row) : null;
}

export async function getCaseByKey(versionId: string, caseKey: string): Promise<DatasetCase | null> {
  const row = await queryOne<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM dataset_cases WHERE dataset_version_id = $1 AND case_key = $2`,
    [versionId, caseKey],
  );
  return row ? toCase(row) : null;
}

/**
 * 检索就绪度（PG-02 步骤 3 阻塞校验的唯一数据来源，SPEC-M1 R-7）。
 *
 * `ALL` = 每条 Case 都有非空 `retrieval.relevant`；`NONE` = 一条都没有；
 * 其余为 `PARTIAL`。只有 `ALL` 才允许启用三个检索算子。
 */
export async function getRetrievalReadiness(versionId: string): Promise<RetrievalReadiness> {
  const row = await queryOne<{ total: string; annotated: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE retrieval IS NOT NULL)::text AS annotated
       FROM dataset_cases WHERE dataset_version_id = $1`,
    [versionId],
  );
  const total = Number(row?.total ?? 0);
  const annotated = Number(row?.annotated ?? 0);
  const state: RetrievalReadiness['state'] =
    total === 0 ? 'NONE' : annotated === total ? 'ALL' : annotated === 0 ? 'NONE' : 'PARTIAL';
  return { state, annotatedCount: annotated, totalCount: total };
}

// ---------------------------------------------------------------------------
// 写入：导入即新版本（R-1 / R-4 / R-5）
// ---------------------------------------------------------------------------

export type CreateVersionResult =
  | { kind: 'created'; version: DatasetVersion }
  | { kind: 'conflict'; existingVersionNo: number; contentHash: string };

/**
 * 在一个事务里创建新版本 + 全部 Case。
 *
 * 冲突判定按 R-4：命中**该数据集任一已有版本**的内容指纹 ⇒ 不产生新版本。
 * 冲突时事务内不写入任何行，因此不会留下「空版本」。
 *
 * `expectedContentHash` 不符 ⇒ 由调用方先行校验并返回 409（R-5），
 * 这里只负责「算出来的真实指纹」。
 */
export async function createVersion(p: {
  datasetId: string;
  normalizedCases: readonly NormalizedCase[];
  source: string;
  note?: string | undefined;
  createdBy: string;
}): Promise<CreateVersionResult> {
  const contentHash = computeContentHash(
    p.normalizedCases.map((c) => ({
      caseKey: c.caseKey,
      input: c.input,
      ...(c.reference ? { reference: c.reference } : {}),
      ...(c.retrieval ? { retrieval: c.retrieval } : {}),
      metadata: c.metadata,
    })),
  );

  return withTransaction(async (client: PoolClient) => {
    // 锁住容器行，避免并发导入算出同一个 version_no
    await client.query(`SELECT id FROM datasets WHERE id = $1 FOR UPDATE`, [p.datasetId]);

    const dup = await client.query<{ version_no: number }>(
      `SELECT version_no FROM dataset_versions
        WHERE dataset_id = $1 AND content_hash = $2
        ORDER BY version_no ASC LIMIT 1`,
      [p.datasetId, contentHash],
    );
    const existing = dup.rows[0];
    if (existing) {
      return {
        kind: 'conflict' as const,
        existingVersionNo: existing.version_no,
        contentHash,
      };
    }

    const next = await client.query<{ version_no: number }>(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
         FROM dataset_versions WHERE dataset_id = $1`,
      [p.datasetId],
    );
    const versionNo = next.rows[0]?.version_no ?? 1;

    const inserted = await client.query<VersionRow>(
      `INSERT INTO dataset_versions
         (dataset_id, version_no, schema_version, case_count, content_hash, source, note, created_by)
       VALUES ($1, $2, '1', $3, $4, $5, $6, $7)
       RETURNING ${VERSION_COLUMNS}`,
      [
        p.datasetId,
        versionNo,
        p.normalizedCases.length,
        contentHash,
        p.source,
        p.note ?? null,
        p.createdBy,
      ],
    );
    const versionRow = inserted.rows[0];
    if (!versionRow) throw new Error('创建版本未返回行');

    for (const c of p.normalizedCases) {
      await client.query(
        `INSERT INTO dataset_cases
           (dataset_version_id, case_key, seq, input, reference, retrieval, metadata)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)`,
        [
          versionRow.id,
          c.caseKey,
          c.seq,
          JSON.stringify(c.input),
          c.reference === null ? null : JSON.stringify(c.reference),
          c.retrieval === null ? null : JSON.stringify(c.retrieval),
          JSON.stringify(c.metadata),
        ],
      );
    }

    await client.query(`UPDATE datasets SET updated_at = now() WHERE id = $1`, [p.datasetId]);

    return { kind: 'created' as const, version: toVersion(versionRow) };
  }).catch((err: unknown) => {
    if (isUniqueViolation(err)) {
      // 并发下另一路已经用同一个 version_no 落库 —— 让调用方按 409 处理
      throw Object.assign(new Error('版本号并发冲突'), { code: '23505', cause: err });
    }
    throw err;
  });
}
