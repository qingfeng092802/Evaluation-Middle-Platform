/**
 * 导入器 · 逐行校验的公共部分。
 *
 * 两种格式共用同一份「单条 Case 合法性」判定，避免 JSONL 与 CSV 各写一套规则
 * 然后慢慢漂移（AC-3 要求两种格式给出**等价**的 okCount / failedCount）。
 */
import type { DatasetCaseInput, ImportIssue, ImportValidationReport } from '@eval-platform/contracts';

/** 校验单条 Case；返回 issue 列表（空数组 = 合法）。 */
export function validateCaseInput(raw: unknown): { issues: Omit<ImportIssue, 'line'>[] } {
  const issues: Omit<ImportIssue, 'line'>[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: '该行不是 JSON 对象' }] };
  }
  const obj = raw as Record<string, unknown>;

  const caseKey = obj['case_key'] ?? obj['caseKey'];
  const hasCaseKey = typeof caseKey === 'string' && caseKey.trim().length > 0;

  const input = obj['input'];
  const inputObj =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const query = inputObj?.['query'];
  const hasQuery = typeof query === 'string' && query.trim().length > 0;

  // AC-3 的原文文案：两个缺失同时出现时必须逐字是这个说法
  if (!hasCaseKey && !hasQuery) {
    issues.push({ field: 'case_key', message: '缺少 case_key 且 input 为空' });
    return { issues };
  }
  if (!hasCaseKey) {
    issues.push({ field: 'case_key', message: '缺少 case_key（且无法从 input 推导）' });
  }
  if (!hasQuery) {
    issues.push({ field: 'input.query', message: '缺少 input.query（必填非空）' });
  }

  const retrieval = obj['retrieval'];
  if (retrieval !== undefined && retrieval !== null) {
    const relevant = (retrieval as Record<string, unknown>)['relevant'];
    if (!Array.isArray(relevant) || relevant.length === 0) {
      issues.push({ field: 'retrieval.relevant', message: 'retrieval.relevant 必须是非空数组' });
    }
  }

  const reference = obj['reference'];
  if (reference !== undefined && reference !== null && typeof reference !== 'object') {
    issues.push({ field: 'reference', message: 'reference 必须是对象' });
  }

  return { issues };
}

/** 把 `snake_case` 的原始行转成 `DatasetCaseInput`（camelCase 传输层）。 */
export function toCaseInput(raw: Record<string, unknown>): DatasetCaseInput {
  const caseKey = raw['case_key'] ?? raw['caseKey'];
  const reference = raw['reference'];
  const retrieval = raw['retrieval'];
  const metadata = raw['metadata'];
  const out: DatasetCaseInput = {
    input: raw['input'] as DatasetCaseInput['input'],
  };
  if (typeof caseKey === 'string' && caseKey.trim().length > 0) out.caseKey = caseKey;
  if (reference && typeof reference === 'object') {
    out.reference = reference as DatasetCaseInput['reference'];
  }
  if (retrieval && typeof retrieval === 'object') {
    out.retrieval = retrieval as DatasetCaseInput['retrieval'];
  }
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    out.metadata = metadata as DatasetCaseInput['metadata'];
  }
  return out;
}

/** 汇总为契约要求的 `ImportValidationReport`。`canCommit` 只在「有通过且零失败」时为 true。 */
export function buildReport(
  okCount: number,
  issues: readonly ImportIssue[],
): ImportValidationReport {
  return {
    okCount,
    failedCount: issues.length,
    issues: [...issues],
    canCommit: okCount > 0 && issues.length === 0,
  };
}
