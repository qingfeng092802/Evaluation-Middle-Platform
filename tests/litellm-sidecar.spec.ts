/**
 * LiteLLM sidecar 接入（Batch 2 · 交付物 1）。
 *
 * 原文：「LiteLLM sidecar 接入（路由与并发限流）；**成本口径仍只由自有
 * `model_prices` 计算**（`TS-2` 红线，永不采信上游 `cost`/`usage`）」。
 *
 * ## 这个文件在钉什么
 *
 * sidecar 的价值是「把多厂商路由从 TS 代码里挪出去」（`technical-solution.md` TS-2）。
 * 一旦配置写错，症状不是报错，而是**它悄悄工作得挺好，直到有人开始读它的成本**。
 * 所以这里钉三条：
 *
 *  1. **生成的路由表里没有明文 Key**。`config.yaml` 是落在磁盘上的普通文本，
 *     把 Key 写进去等于把「只写不读」搬到了另一台进程上重犯一次。因此只能写
 *     `os.environ/<变量名>` 的间接引用，且变量名必须能从厂商稳定推出来。
 *  2. **成本字段一个都不能有**。LiteLLM 支持 `input_cost_per_token` 之类的写法，
 *     写进去它就会开始自算成本，运维顺手一读就把 `model_prices` 挤成了第二事实源。
 *     断言方式是**禁止这些键名出现在产物里**，而不是「我们没写」。
 *  3. **停用的厂商不进路由表**。种子 provider 已置 `is_active=false`（交付物 6），
 *     若生成器把它当默认路径带上，就绕过了刚建立的「必须显式配置」闸门。
 *
 * ## 为什么不启动真的 LiteLLM
 *
 * 门禁必须能在**无 Docker、无网络**的机器上跑完（`工程规则` §9）。
 * 这里断言的是「我们交给它的那份配置」，它是纯字符串，可被逐字检查；
 * 真栈联调属 Batch 4（`[INT-M2-01]`）。
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildLitellmConfig,
  deriveProviderEnvVar,
  PROVIDER_KEY_ENV_PREFIX,
  type LitellmRouteInput,
} from '../lib/gateway/litellm-config.js';
import { resolveChatTarget } from '../lib/gateway/target.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROUTES: readonly LitellmRouteInput[] = [
  {
    providerId: '11111111-1111-4111-8111-111111111111',
    name: 'DeepSeek 主账号',
    kind: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    maxConcurrency: 4,
    rpmLimit: 60,
    tpmLimit: 100_000,
    isActive: true,
    models: [{ modelId: 'deepseek-chat', displayName: 'DeepSeek Chat' }],
  },
  {
    providerId: '22222222-2222-4222-8222-222222222222',
    name: '本地离线自检（fixture）',
    kind: 'openai_compatible',
    baseUrl: 'http://127.0.0.1:8787',
    maxConcurrency: 8,
    rpmLimit: null,
    tpmLimit: null,
    isActive: false,
    models: [{ modelId: 'fixture-echo-1', displayName: 'Fixture Echo' }],
  },
];

describe('deriveProviderEnvVar · Key 只能以环境变量名出现', () => {
  it('变量名带上项目前缀，且不同厂商互不相同', () => {
    const a = deriveProviderEnvVar('11111111-1111-4111-8111-111111111111');
    const b = deriveProviderEnvVar('22222222-2222-4222-8222-222222222222');
    expect(a.startsWith(PROVIDER_KEY_ENV_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('变量名只含 A-Z0-9_（可以安全写进 YAML 与 shell）', () => {
    expect(deriveProviderEnvVar('11111111-1111-4111-8111-111111111111')).toMatch(/^[A-Z0-9_]+$/);
  });

  it('同名不同 id 的厂商不会撞变量名（用 id 而不是名称推导）', () => {
    // 名称里有中文与括号（种子行就是这样），拿名称推变量名会产出非法标识符。
    const a = deriveProviderEnvVar('33333333-3333-4333-8333-333333333333');
    expect(a).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe('buildLitellmConfig · 路由与并发限流', () => {
  const yaml = buildLitellmConfig(ROUTES);

  it('停用的厂商不进路由表（fixture 就是停用状态）', () => {
    expect(yaml).not.toContain('fixture-echo-1');
    expect(yaml).not.toContain('127.0.0.1:8787');
  });

  it('启用的厂商按模型逐个出条目，model_name 用模型标识（我方口径）', () => {
    expect(yaml).toContain('model_name: deepseek-chat');
    // 厂商侧模型名必须原样透传，不能被我们的展示名替换
    expect(yaml).toContain('model: openai/deepseek-chat');
  });

  it('api_base 取厂商 base_url', () => {
    expect(yaml).toContain('api_base: https://api.deepseek.com');
  });

  it('并发上限映射到 max_parallel_requests', () => {
    expect(yaml).toContain('max_parallel_requests: 4');
  });

  it('rpm / tpm 有值时映射进条目，无值时不写该键', () => {
    expect(yaml).toContain('rpm: 60');
    expect(yaml).toContain('tpm: 100000');
  });

  it('未设限的启用厂商：条目里干脆没有 rpm / tpm 这两个键', () => {
    // 上一条的 null 分支其实没被走到——那条 route 是停用的、整块被跳过了。
    // 这里补一条**启用但未设限**的厂商，否则「NULL = 不限」在产物里从未被验证。
    const route: LitellmRouteInput = {
      providerId: '44444444-4444-4444-8444-444444444444',
      name: '自建网关',
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.5:8000',
      maxConcurrency: 2,
      rpmLimit: null,
      tpmLimit: null,
      isActive: true,
      models: [{ modelId: 'self-host-7b', displayName: 'Self Host 7B' }],
    };
    const only = buildLitellmConfig([route]);
    expect(only).toContain('model_name: self-host-7b');
    expect(only).toContain('max_parallel_requests: 2');
    // `rpm:` 作为独立行出现才算写了；注释里出现不算（产物里有「rpm」字样吗？没有）
    expect(only).not.toMatch(/^\s+rpm:/m);
    expect(only).not.toMatch(/^\s+tpm:/m);
  });

  it('三个限流参数都落在 litellm_params 下（同一段，不能漂到 model_info 后面）', () => {
    // 漂移的后果是 LiteLLM 静默忽略：它只认 litellm_params 里的限流键。
    const only = buildLitellmConfig([ROUTES[0]!]);
    const lines = only.split('\n').map((l) => l.trim());
    const idx = lines.indexOf('litellm_params:');
    expect(idx, '缺 litellm_params 段').toBeGreaterThanOrEqual(0);
    const section = lines.slice(idx + 1, idx + 8);
    expect(section).toContain('api_key: os.environ/' + deriveProviderEnvVar(ROUTES[0]!.providerId));
    expect(section).toContain('max_parallel_requests: 4');
    expect(section).toContain('rpm: 60');
    expect(section).toContain('tpm: 100000');
  });

  it('某厂商没报价 ⇒ 不进路由表（算不出钱的路由是假通路）', () => {
    const noModels: LitellmRouteInput = {
      providerId: '55555555-5555-4555-8555-555555555555',
      name: '未报价厂商',
      kind: 'openai_compatible',
      baseUrl: 'https://api.example.com',
      maxConcurrency: 4,
      rpmLimit: null,
      tpmLimit: null,
      isActive: true,
      models: [],
    };
    const only = buildLitellmConfig([noModels]);
    expect(only).not.toContain('api.example.com');
  });
});

describe('buildLitellmConfig · 红线：Key 与成本', () => {
  const yaml = buildLitellmConfig(ROUTES);

  it('不出现任何 Key 明文，只写 os.environ 间接引用', () => {
    const envVar = deriveProviderEnvVar('11111111-1111-4111-8111-111111111111');
    expect(yaml).toContain(`api_key: os.environ/${envVar}`);
    // 形如 sk-xxxxxx 的凭据一律不该出现（本测试的输入里没有 Key，这里是防回归）
    expect(yaml).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it('产物里没有任何成本字段（TS-2：成本只由 model_prices 算）', () => {
    for (const forbidden of [
      'input_cost_per_token',
      'output_cost_per_token',
      'input_cost_per_second',
      'cost',
      'usage',
    ]) {
      expect(yaml, `产物里出现了 ${forbidden}，会让 LiteLLM 自算成本`).not.toContain(forbidden);
    }
  });

  it('重试次数归零：重试只由我方 lib/gateway 负责（否则退避会叠乘）', () => {
    expect(yaml).toContain('num_retries: 0');
  });

  it('空路由表也产出合法骨架（不是空字符串）', () => {
    const empty = buildLitellmConfig([]);
    expect(empty).toContain('model_list:');
    expect(empty).toContain('router_settings:');
  });
});

describe('resolveChatTarget · 直连厂商 还是 走 sidecar', () => {
  const provider = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-live-abcdef1234',
  };

  it('未配置 LITELLM_BASE_URL ⇒ 直连厂商（M1 行为不变，无需任何迁移）', () => {
    const t = resolveChatTarget(provider, {});
    expect(t).toEqual({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-live-abcdef1234',
    });
  });

  it('配置了 LITELLM_BASE_URL ⇒ baseUrl 换成 sidecar，且**不**再带上厂商 Key', () => {
    // 关键：sidecar 侧用 os.environ 里的 Key，我方传 Key 过去等于让它多一个
    // 可读明文的地方。走 sidecar 时 upstream 只认「请求方身份」，
    // 用 sidecar 自己的 master key（缺省为占位值）。
    const t = resolveChatTarget(provider, { LITELLM_BASE_URL: 'http://127.0.0.1:4000/' });
    expect(t.baseUrl).toBe('http://127.0.0.1:4000');
    expect(t.apiKey).not.toBe('sk-live-abcdef1234');
    expect(t.apiKey).not.toContain('sk-live');
  });

  it('sidecar 的 bearer 用 LITELLM_MASTER_KEY，缺省给一个非业务占位值', () => {
    const withKey = resolveChatTarget(provider, {
      LITELLM_BASE_URL: 'http://127.0.0.1:4000',
      LITELLM_MASTER_KEY: 'sk-sidecar-master-xyz',
    });
    expect(withKey.apiKey).toBe('sk-sidecar-master-xyz');

    const fallback = resolveChatTarget(provider, { LITELLM_BASE_URL: 'http://127.0.0.1:4000' });
    expect(fallback.apiKey).toBe('no-master-key-configured');
  });

  it('空的 LITELLM_BASE_URL 视为未配置（避免拼出 `/v1/chat/completions` 这种相对地址）', () => {
    const t = resolveChatTarget(provider, { LITELLM_BASE_URL: '   ' });
    expect(t.baseUrl).toBe('https://api.deepseek.com');
  });

  it('模型标识原样透传，不做「厂商前缀」改写（sidecar 的 model_name 就是模型标识）', () => {
    const t = resolveChatTarget(provider, { LITELLM_BASE_URL: 'http://127.0.0.1:4000' });
    expect(t).not.toHaveProperty('model');
  });
});

describe('docker-compose · sidecar 随 compose 起，但默认不拖慢 db:up', () => {
  it('存在 litellm 服务，且挂在 profile 上（`docker compose up -d db` 不受影响）', async () => {
    const src = await readFile(resolve(ROOT, 'docker-compose.yml'), 'utf8');
    expect(src).toContain('litellm:');
    expect(src).toMatch(/profiles:\s*\[[^\]]*gateway[^\]]*\]/);
  });

  it('sidecar 的 Key 走环境变量注入，compose 里不出现任何真实 Key', async () => {
    const src = await readFile(resolve(ROOT, 'docker-compose.yml'), 'utf8');
    expect(src).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it('配置模板存在，且模板里同样没有明文 Key', async () => {
    const src = await readFile(resolve(ROOT, 'tools', 'litellm', 'config.example.yaml'), 'utf8');
    expect(src).toContain('model_list:');
    expect(src).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it('模板与生成器同构：模板里 litellm_params 下的键，生成器都会产出', async () => {
    // 模板是给人读的说明书。说明书一旦和生成物漂移，读者会照着它写出
    // 一份 LiteLLM 静默忽略的配置——所以这里比对「键名集合」，而不是靠人肉 review。
    const tpl = await readFile(resolve(ROOT, 'tools', 'litellm', 'config.example.yaml'), 'utf8');
    const gen = buildLitellmConfig([ROUTES[0]!]);

    const keysInParams = (text: string): string[] => {
      const lines = text.split('\n');
      const start = lines.findIndex((l) => l.trim() === 'litellm_params:');
      if (start < 0) return [];
      const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0].length ?? 0);
      const indent = indentOf(lines[start + 1] ?? '');
      const out: string[] = [];
      for (const line of lines.slice(start + 1)) {
        if (line.trim() === '') continue;
        if (indentOf(line) < indent) break;
        const m = /^\s*([a-z_]+):/.exec(line);
        if (m?.[1] !== undefined) out.push(m[1]);
      }
      return out.sort();
    };

    expect(keysInParams(tpl)).toEqual(keysInParams(gen));
  });
});
