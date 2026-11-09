/**
 * Prompt 模板渲染（T1 目标）。
 *
 * 只支持三种变量，且**不做表达式求值**（不 eval、不引第三方模板引擎）：
 *  - `{{input.query}}` —— 当前 Case 的 query
 *  - `{{input}}` —— 当前 Case 的 query（简写，种子与演示都用它）
 *  - `{{context}}` —— 检索上下文拼接（M1 无真实检索，恒为空串）
 *  - `{{reference.golden_answer}}` —— 仅在调试模板里可能出现
 *
 * 未知变量**原样保留**（不报错、不置空）：让 `{{unknown}}` 出现在输出里
 * 比悄悄替换成空串更容易被发现。
 */
import type { DatasetCase } from '@eval-platform/contracts';

export interface RenderVars {
  readonly case: DatasetCase;
  readonly context?: string | undefined;
}

export function renderPrompt(template: string, vars: RenderVars): string {
  const query = (vars.case.input as { query?: unknown }).query;
  const queryText = typeof query === 'string' ? query : '';
  const golden = vars.case.reference?.golden_answer ?? '';

  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
    switch (name) {
      case 'input':
      case 'input.query':
        return queryText;
      case 'context':
        return vars.context ?? '';
      case 'reference.golden_answer':
        return golden;
      default:
        return whole;
    }
  });
}
