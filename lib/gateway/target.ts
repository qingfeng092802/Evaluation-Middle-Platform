/**
 * 一次网关调用的「往哪儿发」（`TS-2` · LiteLLM 只是可选的中间层）。
 *
 * ## 为什么要有这一层
 *
 * 执行路径（`execute-case.ts` / `judge-chat.ts`）只该关心「发给哪个模型」，
 * 不该关心「中间有没有一个代理」。但这两件事恰恰有一个**很容易做错的差别**：
 *
 *   - **直连厂商**：Bearer 是厂商 Key —— 从数据库密文还原出来的那个明文；
 *   - **走 LiteLLM**：Bearer 是 sidecar 自己的 master key，厂商 Key 在
 *     sidecar 进程里由 `os.environ` 提供。此时**绝不能**把厂商 Key 一起发过去，
 *     那等于给「只读不回」的凭据又多开了一个可读出口。
 *
 * 所以「换不换上游」和「换不换 Key」必须是同一个决定，写在同一处。
 * 拆成两处的话，迟早会出现「地址换了、Key 没换」——症状是 sidecar 日志里
 * 出现一堆 401，而上游看起来一切正常。
 *
 * ## 为什么不默认走 sidecar
 *
 * 默认行为必须与 M1 完全一致（没配 `LITELLM_BASE_URL` 就直连），
 * 否则「升级一下代码，所有既有 run 突然要求先起 docker」。
 */

/** 未配置 master key 时发给 sidecar 的占位 Bearer（sidecar 若启用鉴权会拒绝，属预期）。 */
const NO_MASTER_KEY = 'no-master-key-configured';

export interface ChatTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface ProviderConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * 决定这次调用往哪儿发、带哪个 Bearer。
 *
 * `env` 显式传入（而不是读 `process.env`），这样测试不必污染进程环境，
 * 调用点也能一次读快照、不必担心中途被改。
 */
export function resolveChatTarget(
  provider: ProviderConnection,
  env: { readonly LITELLM_BASE_URL?: string | undefined; readonly LITELLM_MASTER_KEY?: string | undefined },
): ChatTarget {
  const raw = env.LITELLM_BASE_URL?.trim() ?? '';
  if (raw === '') return { baseUrl: provider.baseUrl, apiKey: provider.apiKey };

  const master = env.LITELLM_MASTER_KEY?.trim() ?? '';
  return {
    // 去掉尾斜杠，与 `chatComplete` 里 `${baseUrl}/v1/chat/completions` 的拼法一致
    baseUrl: raw.replace(/\/+$/, ''),
    apiKey: master === '' ? NO_MASTER_KEY : master,
  };
}

/**
 * 生产调用点用的一行版：从 `process.env` 取快照后转调上面的纯函数。
 *
 * **每次调用现读**（不在模块加载时快照）：模块可能在 `dev:all` 注入环境变量
 * 之前就被加载，快照会把「配置为空」永久钉死，而症状是「明明配了却一直直连」。
 */
export function chatTargetFromEnv(provider: ProviderConnection): ChatTarget {
  return resolveChatTarget(provider, {
    LITELLM_BASE_URL: process.env['LITELLM_BASE_URL'],
    LITELLM_MASTER_KEY: process.env['LITELLM_MASTER_KEY'],
  });
}
