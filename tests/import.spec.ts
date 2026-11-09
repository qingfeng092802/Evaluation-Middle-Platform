/**
 * 导入器黄金测试（AC-2 / AC-3 的单元侧）。
 *
 * 这里只测**纯逻辑**：canonical 指纹、case_key 推导、JSONL/CSV 逐行定位。
 * 真库落库与 409 冲突在 `tests/api-datasets.spec.ts`（L2 集成切片）里测。
 *
 * 关键口径（SPEC-M1 R-1 / R-2 / R-3、D-11）：
 *  - 指纹与行序无关（同一批 Case 打乱顺序 ⇒ 同 hash）；
 *  - `case_key` 缺省 = `sha256(canonicalJson(input))` 前 16 位；
 *  - `seq` = 按 `case_key` 升序的 0-based 下标；
 *  - **行号 1-based 且计入 CSV 表头**：坏行在数据第 47 条 ⇒ CSV 物理行 48。
 */
import { describe, expect, it } from 'vitest';
import type { DatasetCaseInput } from '@eval-platform/contracts';
import {
  canonicalJson,
  computeContentHash,
  deriveCaseKey,
  normalizeCases,
} from '../lib/import/canonical.js';
import { parseJsonl } from '../lib/import/jsonl.js';
import { parseCsv } from '../lib/import/csv.js';

// ---------------------------------------------------------------------------
// canonical JSON 与指纹
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('对象 key 递归字典序，数组保序', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
  });

  it('输出为 UTF-8 紧凑串（无多余空格），中文原样保留', () => {
    expect(canonicalJson({ q: '退款率' })).toBe('{"q":"退款率"}');
  });

  it('null / 标量 / 空对象都稳定', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(1.5)).toBe('1.5');
  });
});

describe('deriveCaseKey（R-3）', () => {
  it('同一 input 得同 key；key 形如 16 位小写 hex', () => {
    const a = deriveCaseKey({ query: '退款率是多少' });
    const b = deriveCaseKey({ query: '退款率是多少' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('input 差一个字即换 key', () => {
    expect(deriveCaseKey({ query: '退款率是多少' })).not.toBe(
      deriveCaseKey({ query: '退款率是多少？' }),
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeCases / computeContentHash
// ---------------------------------------------------------------------------

function mkCase(key: string, query: string): DatasetCaseInput {
  return {
    caseKey: key,
    input: { query },
    reference: { golden_answer: `答：${query}` },
    retrieval: { relevant: [{ doc_id: 'doc-1', grade: 1 }] },
  };
}

describe('normalizeCases（R-2 / R-3）', () => {
  it('按 case_key 升序重排并给 0-based seq', () => {
    // 传入顺序 case-03, case-01, case-02 ⇒ seq 应为 01→0, 02→1, 03→2
    const out = normalizeCases([
      mkCase('case-03', 'c'),
      mkCase('case-01', 'a'),
      mkCase('case-02', 'b'),
    ]);
    expect(out.map((c) => c.caseKey)).toEqual(['case-01', 'case-02', 'case-03']);
    expect(out.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it('缺 caseKey 时用 input 的 hash 补齐', () => {
    const out = normalizeCases([{ input: { query: '只有一个 query' } }]);
    const key = deriveCaseKey({ query: '只有一个 query' });
    expect(out[0]?.caseKey).toBe(key);
  });

  it('metadata 缺省补成 {}，reference / retrieval 原样保留', () => {
    const out = normalizeCases([mkCase('k', 'q')]);
    expect(out[0]?.metadata).toEqual({});
    expect(out[0]?.reference).toEqual({ golden_answer: '答：q' });
    expect(out[0]?.retrieval).toEqual({ relevant: [{ doc_id: 'doc-1', grade: 1 }] });
  });
});

describe('computeContentHash（R-1）', () => {
  it('同一批 Case 打乱行序 ⇒ 完全相同的 64 位 hex', () => {
    const a = computeContentHash([mkCase('case-01', 'a'), mkCase('case-02', 'b')]);
    const b = computeContentHash([mkCase('case-02', 'b'), mkCase('case-01', 'a')]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('改一条 query ⇒ hash 变化', () => {
    const a = computeContentHash([mkCase('case-01', 'a')]);
    const b = computeContentHash([mkCase('case-01', 'a!')]);
    expect(a).not.toBe(b);
  });

  it('只是 seq 不同（输入顺序不同）不影响 hash —— seq 由重排决定，不参与指纹', () => {
    const a = computeContentHash([mkCase('case-02', 'b'), mkCase('case-01', 'a')]);
    const b = computeContentHash([mkCase('case-01', 'a'), mkCase('case-02', 'b')]);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// JSONL 解析与逐行定位（AC-3）
// ---------------------------------------------------------------------------

/** 造 50 行合法 JSONL，第 47 行（1-based）是坏行。 */
function jsonlWithBadLine47(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++) {
    if (i === 47) {
      lines.push(JSON.stringify({ input: {} }));
      continue;
    }
    const n = String(i).padStart(4, '0');
    lines.push(
      JSON.stringify({
        case_key: `case-${n}`,
        input: { query: `问题 ${n}` },
        reference: { golden_answer: `答案 ${n}` },
        retrieval: { relevant: [{ doc_id: `doc-${n}`, grade: 1 }] },
      }),
    );
  }
  return lines.join('\n');
}

describe('parseJsonl（AC-3）', () => {
  it('50 行坏 1 行 ⇒ okCount=49、failedCount=1、issues[0].line=47、canCommit=false', () => {
    const { report } = parseJsonl(jsonlWithBadLine47());
    expect(report.failedCount).toBe(1);
    expect(report.okCount).toBe(49);
    expect(report.issues[0]?.line).toBe(47);
    expect(report.canCommit).toBe(false);
  });

  it('坏行文案为「缺少 case_key 且 input 为空」', () => {
    const { report } = parseJsonl(jsonlWithBadLine47());
    expect(report.issues[0]?.message).toContain('缺少 case_key 且 input 为空');
  });

  it('全部合法 ⇒ canCommit=true，且解析出的条数正确', () => {
    const text = jsonlWithBadLine47()
      .split('\n')
      .filter((_, i) => i !== 46)
      .join('\n');
    const { report, cases } = parseJsonl(text);
    expect(report.okCount).toBe(49);
    expect(report.failedCount).toBe(0);
    expect(report.canCommit).toBe(true);
    expect(cases).toHaveLength(49);
  });

  it('空文件 ⇒ okCount=0、canCommit=false（不允许提交空版本）', () => {
    const { report } = parseJsonl('\n\n');
    expect(report.okCount).toBe(0);
    expect(report.canCommit).toBe(false);
  });

  it('非法 JSON 的物理行号也按 1-based 报出', () => {
    const { report } = parseJsonl('{"case_key":"a","input":{"query":"q"}}\n{坏行\n');
    expect(report.issues[0]?.line).toBe(2);
    expect(report.canCommit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSV 解析与逐行定位（AC-3：表头计入物理行号）
// ---------------------------------------------------------------------------

const CSV_HEADER =
  'case_key,query,golden_answer,relevant,reference_facts,metadata';

/** 造 50 条数据行的 CSV，坏行落在数据第 47 条 ⇒ 物理行 48。 */
function csvWithBadDataLine47(): string {
  const lines = [CSV_HEADER];
  for (let i = 1; i <= 50; i++) {
    if (i === 47) {
      // case_key 空 + query 空
      lines.push(',,,,relevants=[]');
      continue;
    }
    const n = String(i).padStart(4, '0');
    lines.push(`case-${n},问题 ${n},答案 ${n},"[{""doc_id"":""doc-${n}"",""grade"":1}]",,`);
  }
  return lines.join('\n');
}

describe('parseCsv（AC-3 / D-11）', () => {
  it('表头计入物理行号：坏行在数据第 47 条 ⇒ line=48', () => {
    const { report } = parseCsv(csvWithBadDataLine47());
    expect(report.failedCount).toBe(1);
    expect(report.okCount).toBe(49);
    expect(report.issues[0]?.line).toBe(48);
  });

  it('坏行文案与 JSONL 一致：「缺少 case_key 且 input 为空」', () => {
    const { report } = parseCsv(csvWithBadDataLine47());
    expect(report.issues[0]?.message).toContain('缺少 case_key 且 input 为空');
  });

  it('按表头名取列，不依赖列顺序', () => {
    const text = [
      'query,case_key,golden_answer,relevant',
      '问 A,k-1,答 A,"[{""doc_id"":""d1"",""grade"":2}]"',
    ].join('\n');
    const { report, cases } = parseCsv(text);
    expect(report.failedCount).toBe(0);
    expect(cases[0]?.caseKey).toBe('k-1');
    expect(cases[0]?.input).toEqual({ query: '问 A' });
    expect(cases[0]?.retrieval).toEqual({ relevant: [{ doc_id: 'd1', grade: 2 }] });
  });

  it('引号内的逗号不被当分隔符', () => {
    const text = [
      'case_key,query,golden_answer,relevant',
      'k-1,"甲，乙，丙",答,"[{""doc_id"":""d1"",""grade"":1}]"',
    ].join('\n');
    const { report, cases } = parseCsv(text);
    expect(report.failedCount).toBe(0);
    expect(cases[0]?.input).toEqual({ query: '甲，乙，丙' });
  });

  it('空 CSV（只有表头）⇒ okCount=0、canCommit=false', () => {
    const { report } = parseCsv(CSV_HEADER);
    expect(report.okCount).toBe(0);
    expect(report.canCommit).toBe(false);
  });
});
