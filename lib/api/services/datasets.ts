/**
 * 评测集服务层（`PG-05` 的业务体）。
 *
 * 两条必须在这里落死的口径：
 *
 *  - **R-4 / R-5 都是 409**：内容指纹与已有版本相同 ⇒ `details.existingVersionNo`
 *    告诉用户「你这份数据已经在 v3 里了」，而不是给一个空洞的「冲突」；
 *  - **AC-3.5 服务端兜底**：绕过前端直接提交坏批次时，契约 `parse` 在前、
 *    仓储事务在后 ⇒ **一行都不会落库**，连「空版本」都产生不了。
 */
import type {
  Dataset,
  DatasetVersion,
  DatasetVersionDetail,
  ImportValidationReport,
} from '@eval-platform/contracts';
import { DatasetCreate, DatasetUpdate, DatasetUploadCommit, DatasetVersionCreate } from '@eval-platform/contracts';
import {
  createDataset as repoCreateDataset,
  createVersion,
  getDataset,
  getVersionByNo,
  listCases,
  listDatasets,
  listVersions,
  updateDataset as repoUpdateDataset,
} from '../../../db/repo/datasets.js';
import { computeContentHash, normalizeCases } from '../../import/canonical.js';
import { parseCsv } from '../../import/csv.js';
import { parseJsonl } from '../../import/jsonl.js';
import type { DatasetImportValidateBody } from '@eval-platform/contracts';
import { BadRequestError, ConflictError, NotFoundError } from '../http.js';

const CREATED_BY = process.env['APP_CREATED_BY'] ?? 'm1-local';

/** 统一入口：按 `format` 选解析器。两种格式共用同一套逐行校验。 */
export function validateImport(body: DatasetImportValidateBody): {
  report: ImportValidationReport;
  cases: ReturnType<typeof parseJsonl>['cases'];
} {
  const { cases, report } =
    body.format === 'csv' ? parseCsv(body.content) : parseJsonl(body.content);
  return { report, cases };
}

export async function listDatasetPage(opts: {
  limit: number;
  keyword?: string | undefined;
}): Promise<Dataset[]> {
  return listDatasets(opts);
}

export async function getDatasetOrThrow(id: string): Promise<Dataset> {
  const ds = await getDataset(id);
  if (!ds) throw new NotFoundError('评测集不存在');
  return ds;
}

export async function createDataset(raw: unknown): Promise<Dataset> {
  const body = DatasetCreate.parse(raw);
  return repoCreateDataset({
    name: body.name,
    description: body.description,
    createdBy: CREATED_BY,
  });
}

export async function updateDataset(id: string, raw: unknown): Promise<Dataset> {
  const body = DatasetUpdate.parse(raw);
  await getDatasetOrThrow(id);
  const updated = await repoUpdateDataset(id, {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.description === undefined ? {} : { description: body.description }),
  });
  if (!updated) throw new NotFoundError('评测集不存在');
  return updated;
}

export async function listDatasetVersions(datasetId: string): Promise<DatasetVersion[]> {
  await getDatasetOrThrow(datasetId);
  return listVersions(datasetId);
}

/** 版本详情：版本 + Case 预览 + 机器可读的 `immutable: true`。 */
export async function getVersionDetailOrThrow(
  datasetId: string,
  versionNo: number,
): Promise<DatasetVersionDetail> {
  const version = await getVersionByNo(datasetId, versionNo);
  if (!version) throw new NotFoundError('评测集版本不存在');
  const cases = await listCases(version.id);
  return { ...version, cases, immutable: true };
}

/**
 * 导入并生成新版本（R-1 / R-4 / R-5）。
 *
 * 冲突一律 409：`details.existingVersionNo` 是本系统对用户最有用的那一个字段。
 */
export async function commitDatasetVersion(
  datasetId: string,
  raw: unknown,
): Promise<DatasetVersion> {
  await getDatasetOrThrow(datasetId);

  const body = DatasetVersionCreate.parse(raw);

  // R-5：客户端声明的期望指纹不符 ⇒ 传输可能被截断，直接拒绝（不落库）
  if (body.expectedContentHash !== undefined) {
    const actual = computeContentHash(body.cases);
    if (actual !== body.expectedContentHash) {
      throw new ConflictError('内容指纹与客户端声明不符，可能存在传输截断', {
        expected: body.expectedContentHash,
        actual,
      });
    }
  }

  const result = await createVersion({
    datasetId,
    normalizedCases: normalizeCases(body.cases),
    source: body.source,
    note: body.note,
    createdBy: CREATED_BY,
  });

  if (result.kind === 'conflict') {
    throw new ConflictError('相同内容已存在，未产生新版本', {
      existingVersionNo: result.existingVersionNo,
      contentHash: result.contentHash,
    });
  }
  return result.version;
}

/** 供 `POST /api/datasets/{id}/versions` 返回 201 + 完整详情。 */
export async function commitAndLoadDetail(
  datasetId: string,
  raw: unknown,
): Promise<DatasetVersionDetail> {
  const created = await commitDatasetVersion(datasetId, raw);
  return getVersionDetailOrThrow(datasetId, created.versionNo);
}

/**
 * 上传原始文件 → 校验 → 落库新版本（`PG-05` 区域 3 的「生成新版本」）。
 *
 * 为什么需要这一条：前端拿到的是**文件原文**，而 `/.versions` 的正规入参是
 * 已解析好的 `cases`。若让浏览器自己解析一遍，`lib/import/` 就有了第二份实现 ——
 * 行号口径（`D-11`：CSV 表头计入）会立刻分裂。
 *
 * 因此这里在**服务端**把原文解析成 `cases`，再走同一条 `commitDatasetVersion`：
 * 解析器仍只有一份，落库路径也仍只有一条。
 *
 * 坏行不被静默丢弃：只要 `report.canCommit === false` 就 400，并带上逐行 issue——
 * 「另外两条存进去了、两条没存」是这里最不能接受的结果。
 */
export async function commitUploadedFile(
  datasetId: string,
  raw: unknown,
): Promise<DatasetVersionDetail> {
  const upload = DatasetUploadCommit.parse(raw);
  assertNonEmpty(upload.content);
  const { report, cases } = validateImport(upload);
  if (!report.canCommit) {
    throw new BadRequestError('导入内容未全部通过校验，未写入任何数据', {
      okCount: report.okCount,
      failedCount: report.failedCount,
      issues: report.issues,
    });
  }
  const created = await commitDatasetVersion(datasetId, {
    source: upload.source,
    cases,
    ...(upload.note === undefined ? {} : { note: upload.note }),
  });
  return getVersionDetailOrThrow(datasetId, created.versionNo);
}

/** `format` 缺失时的兜底判定（内容以 `{` 开头视为 JSONL）。 */
export function inferFormat(content: string): 'jsonl' | 'csv' {
  return content.trimStart().startsWith('{') ? 'jsonl' : 'csv';
}

/** 供路由把「文件为空」这类问题与契约校验失败区分开。 */
export function assertNonEmpty(content: string): void {
  if (content.trim() === '') throw new BadRequestError('文件内容为空');
}
