/**
 * 种子 · 本地 fixture 厂商（`model_providers` 唯一一行）。
 *
 * 这是 M1 **唯一**的厂商记录：它指向本机回显网关（`npm run fixture`），
 * 因此「跑一次评测」不需要任何真实 API Key，也不需要联网。
 *
 * 安全约定（`工程规则.md` §9）：
 *  - `apiKeyCiphertext` 存的是**假串**，不是任何真实凭证；
 *  - `apiKeyMasked` 用 `•` 居中遮蔽，前端只显示它；
 *  - 本条数据不含任何外部 URL（`127.0.0.1` 不构成出站依赖）。
 *
 * M2 拆除清单（SPEC-M1 §3.1）：真实网关接入后把本行 `is_active` 置 `false`，
 * 而不是删除 —— 删除会让历史 run 的 `config_snapshot` 指向不存在的 provider。
 */

export const FIXTURE_PROVIDER = {
  name: '本地离线自检（fixture）',
  kind: 'openai_compatible' as const,
  baseUrl: 'http://127.0.0.1:8787',
  /** 假串：网关不校验 Authorization。 */
  apiKeyCiphertext: 'fixture-noop-not-a-real-key',
  apiKeyMasked: 'fixture-••••noop',
  maxConcurrency: 8,
  isActive: true,
} as const;

/** 种子里出现的模型标识（T1 目标默认用它）。 */
export const FIXTURE_MODEL_ID = 'fixture-echo-1' as const;
