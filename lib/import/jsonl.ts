/**
 * 导入器 · JSONL。
 *
 * 行号口径（D-11）：**物理行号，1-based，不含表头**（JSONL 本就没有表头）。
 * 空行跳过但**仍占行号** —— 否则「第 47 行」会随排版变化而漂移，
 * 用户拿着报错去编辑器里跳行会跳错位置。
 */
import type { DatasetCaseInput, ImportIssue } from '@eval-platform/contracts';
import { buildReport, toCaseInput, validateCaseInput } from './common.js';

export interface ParseResult {
  /** 全部通过校验的 Case（顺序即文件顺序，规范化重排在仓储层做）。 */
  readonly cases: DatasetCaseInput[];
  readonly report: ReturnType<typeof buildReport>;
}

export function parseJsonl(content: string): ParseResult {
  const lines = content.split(/\r?\n/);
  const cases: DatasetCaseInput[] = [];
  const issues: ImportIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1; // 1-based 物理行号
    if (line.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      issues.push({ line: lineNo, message: '该行不是合法 JSON' });
      continue;
    }

    const { issues: fieldIssues } = validateCaseInput(parsed);
    if (fieldIssues.length > 0) {
      for (const fi of fieldIssues) issues.push({ line: lineNo, ...fi });
      continue;
    }

    cases.push(toCaseInput(parsed as Record<string, unknown>));
  }

  return { cases, report: buildReport(cases.length, issues) };
}
