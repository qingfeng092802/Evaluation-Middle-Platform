/**
 * 种子 · 本地 fixture 厂商（`model_providers` 种子行）。
 *
 * M1 时它是**唯一**的厂商记录：指向本机回显网关（`npm run fixture`），
 * 因此「跑一次评测」不需要任何真实 API Key，也不需要联网。
 *
 * **M2 · Batch 2 起它已停用**（`isActive: false`）。本行仍保留，理由见下方
 * `isActive` 处的注释 —— 历史 run 的 `config_snapshot` 引着它的 id。
 * 想在没有真实网关的情况下跑通，请显式 `UPDATE model_providers SET is_active = true`，
 * 那是**主动选择**，而不是默认路径。
 *
 * 安全约定（`工程规则.md` §9）：
 *  - `apiKeyCiphertext` 存的是**假串**，不是任何真实凭证；
 *  - `apiKeyMasked` 用 `•` 居中遮蔽，前端只显示它；
 *  - 本条数据不含任何外部 URL（`127.0.0.1` 不构成出站依赖）。
 */

export const FIXTURE_PROVIDER = {
  name: '本地离线自检（fixture）',
  kind: 'openai_compatible' as const,
  baseUrl: 'http://127.0.0.1:8787',
  /** 假串：网关不校验 Authorization。 */
  apiKeyCiphertext: 'fixture-noop-not-a-real-key',
  apiKeyMasked: 'fixture-••••noop',
  maxConcurrency: 8,
  /**
   * **已停用**（M2 · Batch 2 · 交付物 6）。
   *
   * 置 `false` 的原因不是「这行没用了」，而是它不能再充当**默认凭证来源**：
   * 只要它还是 `true`，`RunPreflight.hasProviderCredentials` 就恒为 `true`，
   * 「尚未配置网关」的横幅永远不出现，用户会在不知情的情况下打到本地回显网关，
   * 得到一次**静默的假成功**。
   *
   * 行本身必须保留：历史 run 的 `config_snapshot` 指向它的 id。
   * 停用后 `getProviderForExecution` 与 `hasActiveProvider` 都不再认它（两者都带
   * `AND is_active = true`），要跑通评测必须由用户在 `PG-09` 里配一个真实厂商。
   */
  isActive: false,
} as const;

/** 种子里出现的模型标识（T1 目标默认用它）。 */
export const FIXTURE_MODEL_ID = 'fixture-echo-1' as const;
