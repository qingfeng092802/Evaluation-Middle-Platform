/**
 * `json_schema` 算子。
 *
 * 口径：`extractFromText` 时先从文本抽 JSON 块；用 `ajv` 校验 `schema`。
 * 抽取失败 / 校验失败 → `0`；`reason` 给出首个错误路径（前端要靠它定位模型输出错在哪）。
 */
import Ajv from 'ajv';
import type { JsonSchemaConfig, OperatorContext, OperatorScore } from '@eval-platform/contracts';
import { type ConfigurableOperator } from './shared.js';

/** 抽取候选 JSON 文本：优先 ```json fenced block，其次第一对花括号/方括号之间。 */
export function extractJsonText(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    const body = fenced[1].trim();
    if (body.length > 0) return body;
  }
  const firstBrace = text.search(/[[{]/);
  if (firstBrace < 0) return null;
  const opener = text[firstBrace];
  const closer = opener === '{' ? '}' : ']';
  const lastClose = text.lastIndexOf(closer);
  if (lastClose <= firstBrace) return null;
  return text.slice(firstBrace, lastClose + 1);
}

export const jsonSchemaOperator: ConfigurableOperator<JsonSchemaConfig> = {
  key: 'json_schema',
  kind: 'rule',
  requiresRetrieval: false,

  async score(ctx: OperatorContext, config: JsonSchemaConfig): Promise<OperatorScore> {
    const base = {
      key: 'json_schema',
      kind: 'rule' as const,
      passed: null,
      threshold: null,
      weight: 1,
    };

    if (ctx.actualOutput === null || ctx.actualOutput.trim() === '') {
      return { ...base, score: 0, reason: '输出为空，无法校验 JSON Schema' };
    }

    let candidate: unknown = ctx.actualOutput;
    if (config.extractFromText) {
      const extracted = extractJsonText(ctx.actualOutput);
      if (extracted === null) {
        return { ...base, score: 0, reason: '输出中未找到 JSON 块（抽取失败）' };
      }
      try {
        candidate = JSON.parse(extracted);
      } catch (err) {
        return { ...base, score: 0, reason: `JSON 解析失败：${(err as Error).message}` };
      }
    } else if (typeof candidate === 'string') {
      try {
        candidate = JSON.parse(candidate);
      } catch (err) {
        return { ...base, score: 0, reason: `JSON 解析失败：${(err as Error).message}` };
      }
    }

    const ajv = new Ajv({ allErrors: true, strict: false });
    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(config.schema);
    } catch (err) {
      return { ...base, score: 0, reason: `Schema 本身非法：${(err as Error).message}` };
    }

    if (validate(candidate)) {
      return { ...base, score: 1, reason: 'JSON 通过 Schema 校验' };
    }

    const first = validate.errors?.[0];
    const path = first?.instancePath && first.instancePath !== '' ? first.instancePath : '∅';
    return {
      ...base,
      score: 0,
      reason: `Schema 校验失败于 ${path}：${first?.message ?? '未知错误'}`,
    };
  },
};
