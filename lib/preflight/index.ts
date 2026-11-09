/**
 * 前置校验（PG-02 三条阻塞，SPEC-M1 R-6 / R-7）。
 *
 * 抽成**纯函数**而不是塞进路由，是因为它要能被单测反复断言：
 * 三条阻塞各对应一个 `BLOCKED_*` 码，前端文案与后端码必须一一对齐，
 * 让这条映射关系只存在于一处。
 *
 * 服务端**必须**重跑这套校验：前端把按钮置灰不构成保护，任何人都能直接打 API。
 */
import { EVALUATOR_REQUIRES_RETRIEVAL } from '@eval-platform/contracts';
import type { RunPreflight } from '@eval-platform/contracts';
import type { RetrievalReadiness } from '@eval-platform/contracts';

export type BlockCode =
  | 'BLOCKED_NO_PROVIDER_CREDENTIALS'
  | 'BLOCKED_NO_EVALUATORS'
  | 'BLOCKED_NO_RETRIEVAL_ANNOTATION';

export interface PreflightInput {
  readonly hasProviderCredentials: boolean;
  /** 本次要跑的算子 key 列表。 */
  readonly evaluatorKeys: readonly string[];
  readonly retrievalReadiness: RetrievalReadiness;
}

/** 选中了任一「依赖检索标注」的算子。 */
export function needsRetrieval(evaluatorKeys: readonly string[]): boolean {
  return evaluatorKeys.some(
    (k) => EVALUATOR_REQUIRES_RETRIEVAL[k as keyof typeof EVALUATOR_REQUIRES_RETRIEVAL] === true,
  );
}

/**
 * 判定三条阻塞。
 *
 * 顺序刻意固定（凭证 → 算子 → 检索标注）：前端按 `blockers` 的顺序渲染提示，
 * 顺序稳定才能让「用户修好第一条后看到第二条」是可预期的。
 */
export function evaluatePreflight(input: PreflightInput): RunPreflight {
  const blockers: BlockCode[] = [];

  if (!input.hasProviderCredentials) blockers.push('BLOCKED_NO_PROVIDER_CREDENTIALS');
  if (input.evaluatorKeys.length === 0) blockers.push('BLOCKED_NO_EVALUATORS');

  // R-7：判定依据是**整个版本**，只要不是 ALL 就阻断
  if (needsRetrieval(input.evaluatorKeys) && input.retrievalReadiness.state !== 'ALL') {
    blockers.push('BLOCKED_NO_RETRIEVAL_ANNOTATION');
  }

  return {
    hasProviderCredentials: input.hasProviderCredentials,
    hasEvaluators: input.evaluatorKeys.length > 0,
    retrievalReadiness: input.retrievalReadiness,
    blockers,
    canStart: blockers.length === 0,
  };
}

/** 阻塞码 → 用户可读文案（逐字取自 `pages-and-flows.md` §5）。 */
export const BLOCK_MESSAGES: Readonly<Record<BlockCode, string>> = {
  BLOCKED_NO_PROVIDER_CREDENTIALS: '尚未配置模型网关凭证，无法发起评测。',
  BLOCKED_NO_EVALUATORS: '请至少配置一个评测算子。',
  BLOCKED_NO_RETRIEVAL_ANNOTATION:
    '当前评测集缺少检索标注，Recall@K / MRR / nDCG@K 不可用。请补充标注或取消勾选检索类算子。',
};
