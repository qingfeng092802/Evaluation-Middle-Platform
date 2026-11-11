/**
 * runner 版本串。
 *
 * 写进 `eval_runs.runner_version` 与 `reproducibility.runnerVersion`。
 * 「EvalRun 可解释，不可复现」——版本串的意义是**事后说清是哪套逻辑算的**，
 * 而不是承诺能重算出同一个数（模型侧本来就不确定）。
 */
export const RUNNER_VERSION = 'm1.0.0' as const;
