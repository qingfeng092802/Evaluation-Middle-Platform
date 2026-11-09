/**
 * 导入器 · CSV。
 *
 * 行号口径（D-11，**与 JSONL 不同的唯一一处**）：**表头计入物理行号**。
 * 理由：用户在 Excel / 文本编辑器里看到的行号就是含表头的物理行号；
 * 报「第 47 行」而文件里第 47 行是另一条数据，比不给行号更糟。
 * ⇒ AC-3 里坏行在数据第 47 条时，CSV 必须报 **48**。
 *
 * 列通过**表头名**定位，不依赖列顺序（用户手工改列序不该炸）。
 */
import type { DatasetCaseInput, ImportIssue } from '@eval-platform/contracts';
import { buildReport, toCaseInput, validateCaseInput } from './common.js';

/** 最小 RFC4180 解析：支持引号包裹、引号内逗号、`""` 转义。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 空串视为「未提供」；合法 JSON 则解析（`relevant` / `reference_facts` / `metadata`）。 */
function maybeParseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (t === '') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export function parseCsv(content: string): {
  cases: DatasetCaseInput[];
  report: ReturnType<typeof buildReport>;
} {
  const lines = content.split(/\r?\n/);
  // 找第一条非空行作表头
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    return { cases: [], report: buildReport(0, []) };
  }

  const header = splitCsvLine(lines[headerIdx] as string).map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);

  const idx = {
    caseKey: col('case_key') >= 0 ? col('case_key') : col('casekey'),
    query: col('query'),
    goldenAnswer: col('golden_answer'),
    relevant: col('relevant'),
    referenceFacts: col('reference_facts'),
    metadata: col('metadata'),
  };

  const cases: DatasetCaseInput[] = [];
  const issues: ImportIssue[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    const physicalLine = i + 1; // 1-based，含表头
    const cells = splitCsvLine(raw);
    const pick = (n: number): string | undefined => (n >= 0 ? cells[n] : undefined);

    const row: Record<string, unknown> = {};
    const caseKey = pick(idx.caseKey)?.trim();
    if (caseKey) row['case_key'] = caseKey;

    const query = pick(idx.query)?.trim() ?? '';
    // 空 query 时构造 `{}`，让公共校验器报出「缺少 case_key 且 input 为空」这条统一文案
    row['input'] = query === '' ? {} : { query };

    const golden = pick(idx.goldenAnswer)?.trim();
    const facts = maybeParseJson(pick(idx.referenceFacts));
    if (golden || facts !== undefined) {
      row['reference'] = {
        ...(golden ? { golden_answer: golden } : {}),
        ...(facts !== undefined ? { reference_facts: facts } : {}),
      };
    }

    const relevant = maybeParseJson(pick(idx.relevant));
    if (relevant !== undefined) row['retrieval'] = { relevant };

    const metadata = maybeParseJson(pick(idx.metadata));
    if (metadata !== undefined) row['metadata'] = metadata;

    const { issues: fieldIssues } = validateCaseInput(row);
    if (fieldIssues.length > 0) {
      for (const fi of fieldIssues) issues.push({ line: physicalLine, ...fi });
      continue;
    }
    cases.push(toCaseInput(row));
  }

  return { cases, report: buildReport(cases.length, issues) };
}
