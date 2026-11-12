#!/usr/bin/env node
/**
 * 由 `model_providers` 生成 LiteLLM 的 `config.generated.yaml`
 * （`TS-2` · 网关只做路由与限流）。
 *
 * 用法：`npm run gateway:config`
 *
 * 为什么是一个脚本而不是手写配置：路由表的唯一事实源在数据库里。
 * 手写一份等于让「谁启用了、地址是什么、并发多少」出现两个副本，
 * 而两边不一致不会报错，只会表现成「某个模型偶尔 404」。
 *
 * 两个必须守住的边界（`docs/工程规则.md` §9、`technical-solution.md` TS-2）：
 *   - 产物里**不含任何明文 Key**，只含 `os.environ/<变量名>`；
 *   - 产物里**不含任何计费字段**，成本只由 `model_prices` 计算。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db/repo/_client.js';
import { closeDb } from '../db/schema/index.js';
import {
  buildLitellmConfig,
  deriveProviderEnvVar,
  type LitellmRouteInput,
} from '../lib/gateway/litellm-config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'tools', 'litellm', 'config.generated.yaml');

interface ProviderRow {
  id: string;
  name: string;
  kind: LitellmRouteInput['kind'];
  base_url: string | null;
  max_concurrency: number;
  rpm_limit: number | null;
  tpm_limit: number | null;
  is_active: boolean;
}

interface PriceRow {
  model_provider_id: string;
  model_id: string;
  display_name: string;
}

async function main(): Promise<void> {
  // 模型清单取自「报过价的模型」：没有单价的模型即使路由通了也算不出钱，
  // 放进路由表只会制造「调通了但成本恒为 0」的假象。
  const providers = await query<ProviderRow>(
    `SELECT id, name, kind, base_url, max_concurrency, rpm_limit, tpm_limit, is_active
       FROM model_providers
      ORDER BY created_at`,
  );
  const prices = await query<PriceRow>(
    `SELECT DISTINCT ON (model_provider_id, model_id)
            model_provider_id, model_id, display_name
       FROM model_prices
      ORDER BY model_provider_id, model_id, effective_from DESC`,
  );

  const byProvider = new Map<string, { modelId: string; displayName: string }[]>();
  for (const p of prices) {
    const list = byProvider.get(p.model_provider_id) ?? [];
    list.push({ modelId: p.model_id, displayName: p.display_name });
    byProvider.set(p.model_provider_id, list);
  }

  const routes: LitellmRouteInput[] = providers.map((p) => ({
    providerId: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.base_url,
    maxConcurrency: p.max_concurrency,
    rpmLimit: p.rpm_limit,
    tpmLimit: p.tpm_limit,
    isActive: p.is_active,
    models: byProvider.get(p.id) ?? [],
  }));

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, buildLitellmConfig(routes), 'utf8');

  const active = routes.filter((r) => r.isActive && r.baseUrl !== null && r.models.length > 0);
  console.log(`[gateway:config] 已写入 ${OUT}`);
  console.log(
    `[gateway:config] 启用路由：${String(active.length)} 家厂商 / ` +
      `${String(active.reduce((n, r) => n + r.models.length, 0))} 个模型`,
  );
  if (active.length === 0) {
    console.log(
      '[gateway:config] 提示：没有「已启用且有报价」的厂商，产物只有骨架。请先在 PG-09 配置厂商与单价。',
    );
  }
  for (const r of active) {
    console.log(`[gateway:config] 需要注入：${deriveProviderEnvVar(r.providerId)}（厂商「${r.name}」）`);
  }
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error('[gateway:config] 失败：', err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
