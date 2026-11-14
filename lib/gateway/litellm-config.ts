/**
 * LiteLLM Proxy 路由表生成器（`TS-2` · 网关只做路由与限流）。
 *
 * ## 为什么是「生成」而不是手写一份 `config.yaml`
 *
 * 路由表的唯一事实源是 `model_providers`（谁启用了、地址是什么、并发多少）。
 * 手写 YAML 的后果是两边各记一份，改了一边忘了另一边——而且这种不一致
 * 不会报错，只会表现成「某个模型偶尔 404」。所以：数据库说什么，
 * 这里就生成什么，`config.yaml` 只是它的一个产物。
 *
 * ## 两条不能违反的边界
 *
 * 1. **Key 只以 `os.environ/<变量名>` 形式出现**。YAML 是磁盘上的普通文本，
 *    写进去的明文就等于又一次「可读」。变量名由厂商 id 稳定推导
 *    （`deriveProviderEnvVar`），这样重新生成配置不会让已注入的 Key 失配。
 * 2. **不写任何计费字段**。LiteLLM 自带 `input_cost_per_token` 一类配置，
 *    写上它就会开始自算成本，于是 `model_prices` 变成「其中一个来源」。
 *    `TS-2` 的表述是「只负责路由与限流」，所以成本相关键名一个都不出现。
 *
 * 重试同样归零（`num_retries: 0`）：重试与退避由 `lib/gateway/index.ts`
 * 负责，两边都重试会让退避次数相乘，观测到的延迟与真实故障对不上。
 */

/** 注入给 sidecar 的 Key 环境变量前缀。 */
export const PROVIDER_KEY_ENV_PREFIX = 'LITELLM_PROVIDER_KEY_';

/** 生成路由表所需的最小厂商视图（不依赖 db 层类型，便于单测直接构造）。 */
export interface LitellmRouteInput {
  readonly providerId: string;
  readonly name: string;
  readonly kind: 'openai_compatible' | 'anthropic' | 'litellm';
  readonly baseUrl: string | null;
  readonly maxConcurrency: number;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly isActive: boolean;
  readonly models: readonly { readonly modelId: string; readonly displayName: string }[];
}

/**
 * 厂商 id → 环境变量名。
 *
 * 用 id 而不是名称：名称是给人看的（种子行里就是「本地离线自检（fixture）」），
 * 中文、空格、括号都不能出现在 shell 变量名里。id 是 UUID，去掉连字符后
 * 只剩十六进制字符，天然满足 `[A-Z0-9_]`。
 */
export function deriveProviderEnvVar(providerId: string): string {
  const compact = providerId.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  return `${PROVIDER_KEY_ENV_PREFIX}${compact}`;
}

/** 我方 `kind` → LiteLLM 的 provider 前缀（决定它走哪套适配器）。 */
function litellmPrefix(kind: LitellmRouteInput['kind']): string {
  if (kind === 'anthropic') return 'anthropic';
  if (kind === 'litellm') return 'openai';
  return 'openai';
}

/**
 * 生成 `config.yaml` 正文。
 *
 * 停用的厂商被整体跳过——种子 provider 已置 `is_active=false`（交付物 6），
 * 若它仍出现在路由表里，「未配置凭证」的闸门就被绕过了。
 */
export function buildLitellmConfig(routes: readonly LitellmRouteInput[]): string {
  const entries: string[] = [];

  for (const route of routes) {
    if (!route.isActive) continue;
    if (route.baseUrl === null || route.baseUrl === '') continue;

    const envVar = deriveProviderEnvVar(route.providerId);

    for (const model of route.models) {
      const lines = [
        '  - model_name: ' + model.modelId,
        '    litellm_params:',
        '      model: ' + litellmPrefix(route.kind) + '/' + model.modelId,
        '      api_base: ' + route.baseUrl,
        '      api_key: os.environ/' + envVar,
        // 三个限流参数放在一起：它们都是「这家的这个模型能同时吃多少」，
        // 分开写会让「调并发却忘了调 rpm」变成一次静默的半修复。
        '      max_parallel_requests: ' + String(route.maxConcurrency),
      ];
      if (route.rpmLimit !== null) lines.push('      rpm: ' + String(route.rpmLimit));
      if (route.tpmLimit !== null) lines.push('      tpm: ' + String(route.tpmLimit));
      lines.push('    model_info:', '      display_name: ' + model.displayName);
      entries.push(lines.join('\n'));
    }
  }

  const head = [
    '# 由 lib/gateway/litellm-config.ts 生成，请勿手改。',
    '# 本文件只描述「路由 + 限流」；任何计费字段都不属于这里。',
  ];

  const body = ['model_list:', ...entries];

  const tail = [
    'router_settings:',
    '  # 重试与退避归 lib/gateway/index.ts 管，这里必须为 0 否则会叠乘',
    '  num_retries: 0',
    '  # 同一模型优先挑当前在途请求最少的部署（不看 token 计数，那属于计费）',
    '  routing_strategy: least-busy',
  ];

  return [...head, '', ...body, '', ...tail, ''].join('\n');
}
