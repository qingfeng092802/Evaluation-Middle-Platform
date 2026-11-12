/**
 * 准出条件 2：**分时计费精度**（Batch 2 · 交付物 1）。
 *
 * 原文：「`effective_from` 取价、调价只增行不改行」。
 *
 * ## 这条准出在防两种具体的错
 *
 * 1. **取错价**：同一 `(provider, model)` 有多行单价时，必须取
 *    「`effective_from <= now()` 中最大的那一行」。
 *    写成 `ORDER BY effective_from`（默认 ASC）、或漏掉 `<= now()` 过滤，
 *    都会取到错误的价 —— 前者取到最老的价，后者取到**未来**的价。
 *    两种都是金额错误，且都不会报错，只会在报表上悄悄偏。
 *
 * 2. **改了历史行**：调价必须是 INSERT 新行，不是 UPDATE 旧行。
 *    改旧行会让已经跑完的 run 成本对不上当年账单（`PT-1` / `MP-2`）。
 *
 * ## 为什么不用 mock
 *
 * 「取价」的语义完全由 SQL 的 `ORDER BY … DESC LIMIT 1` 与 `effective_from <= now()`
 * 决定。mock 掉数据库等于把这条 SQL 也 mock 掉，测的就不是它了。
 * 因此这里插真行、真查。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  connect,
  databaseUrl,
  dropAndRecreateSchema,
  migrate,
  resetDatabase,
} from '../db/migrate.js';
import { closeDb } from '../db/schema/index.js';
import { getEffectivePrice } from '../db/repo/modelPrices.js';
import { computeCost } from '@eval-platform/contracts';

let client: Client;
let providerId: string;

beforeEach(async () => {
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  await resetDatabase(databaseUrl());
  client = await connect();
  const p = await client.query<{ id: string }>(
    `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked)
     VALUES ('price-test', 'openai_compatible', 'http://127.0.0.1:1', 'x', 'x-••••x')
     RETURNING id`,
  );
  providerId = p.rows[0]?.id as string;
});

afterAll(async () => {
  if (client) await client.end();
  await closeDb();
});

/** 插一行单价，`effective_from` 用相对现在的小时偏移。 */
async function insertPrice(opts: {
  modelId: string;
  input: number;
  output: number;
  hoursFromNow: number;
}): Promise<void> {
  await client.query(
    `INSERT INTO model_prices
       (model_provider_id, model_id, display_name, input_price_per_1k, output_price_per_1k,
        currency, effective_from)
     VALUES ($1, $2, $2, $3, $4, 'CNY', now() + ($5 || ' hours')::interval)`,
    [providerId, opts.modelId, String(opts.input), String(opts.output), String(opts.hoursFromNow)],
  );
}

describe('准出 2 · 分时取价：取 effective_from <= now() 中最新的一行', () => {
  it('多行历史价时取最近生效的那一行，而不是最老或最贵', async () => {
    await insertPrice({ modelId: 'm1', input: 1, output: 2, hoursFromNow: -48 });
    await insertPrice({ modelId: 'm1', input: 3, output: 4, hoursFromNow: -24 });
    await insertPrice({ modelId: 'm1', input: 5, output: 6, hoursFromNow: -1 });

    const p = await getEffectivePrice(providerId, 'm1');
    expect(p, '必须能取到价').not.toBeNull();
    // 取最新生效（-1h）那一行，而不是 -48h 的 1/2
    expect(p?.inputPricePer1k).toBe(5);
    expect(p?.outputPricePer1k).toBe(6);
  });

  it('未来生效的价不参与当前取价（防止提前按新价计费）', async () => {
    await insertPrice({ modelId: 'm2', input: 2, output: 3, hoursFromNow: -1 });
    await insertPrice({ modelId: 'm2', input: 100, output: 200, hoursFromNow: 24 });

    const p = await getEffectivePrice(providerId, 'm2');
    expect(p?.inputPricePer1k, '不得取到未来生效的价').toBe(2);
    expect(p?.outputPricePer1k).toBe(3);
  });

  it('只有未来价时返回 null（不是回退到 0，也不是取未来价）', async () => {
    await insertPrice({ modelId: 'm3', input: 9, output: 9, hoursFromNow: 48 });
    const p = await getEffectivePrice(providerId, 'm3');
    expect(p, '无当前生效价必须返回 null，让调用方显式处理').toBeNull();
  });

  it('无任何单价时返回 null', async () => {
    expect(await getEffectivePrice(providerId, 'never-configured')).toBeNull();
  });

  it('不同 provider 的同名 model 不串价', async () => {
    await insertPrice({ modelId: 'shared', input: 1, output: 1, hoursFromNow: -1 });
    const other = await client.query<{ id: string }>(
      `INSERT INTO model_providers (name, kind, base_url, api_key_ciphertext, api_key_masked)
       VALUES ('price-test-2', 'openai_compatible', 'http://127.0.0.1:1', 'x', 'x-••••x')
       RETURNING id`,
    );
    const otherId = other.rows[0]?.id as string;
    await client.query(
      `INSERT INTO model_prices
         (model_provider_id, model_id, display_name, input_price_per_1k, output_price_per_1k,
          currency, effective_from)
       VALUES ($1, 'shared', 'shared', '7', '8', 'CNY', now() - interval '1 hour')`,
      [otherId],
    );

    expect((await getEffectivePrice(providerId, 'shared'))?.inputPricePer1k).toBe(1);
    expect((await getEffectivePrice(otherId, 'shared'))?.inputPricePer1k).toBe(7);
  });
});

describe('准出 2 · 调价只增行不改行', () => {
  it('调价后旧行仍在，且历史取价时刻可复现', async () => {
    // 昨天生效的旧价
    await insertPrice({ modelId: 'm4', input: 10, output: 20, hoursFromNow: -24 });
    const old = await getEffectivePrice(providerId, 'm4');
    expect(old?.inputPricePer1k).toBe(10);

    // 今天调价：只增行
    await insertPrice({ modelId: 'm4', input: 30, output: 40, hoursFromNow: -1 });

    const now = await getEffectivePrice(providerId, 'm4');
    expect(now?.inputPricePer1k, '调价后取新价').toBe(30);

    // 关键：旧行必须还在（不是被 UPDATE 掉）
    const cnt = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_prices WHERE model_id = 'm4'`,
    );
    expect(Number(cnt.rows[0]?.n), '调价必须只增行，旧行不得消失').toBe(2);
  });

  it('UPDATE 历史单价行是被允许的 SQL（表上没有 no_update 触发器），但业务侧不得这么做', async () => {
    // 这条用例是**事实登记**而非背书：数据库层没有 no_update 触发器，
    // 因为 model_prices 是「只增」的**业务约定**，不是不可变表（见 database-schema §3.2 的
    // 7 张不可变表清单里没有它）。所以「不改行」靠的是仓储层只提供 INSERT，
    // 而不是靠数据库拒绝。这条断言把「数据库不拦」这个事实钉住，
    // 免得日后有人以为有触发器兜底。
    await insertPrice({ modelId: 'm5', input: 1, output: 1, hoursFromNow: -1 });
    const upd = await client.query(
      `UPDATE model_prices SET input_price_per_1k = 99 WHERE model_id = 'm5'`,
    );
    expect(upd.rowCount, 'model_prices 没有 no_update 触发器（业务约定而非数据库约束）').toBe(1);
  });

  it('同一 (provider, model, effective_from) 重复插入被唯一约束拒绝', async () => {
    // 必须用**固定的字面时间戳**：两次调用 `now()` 会得到微秒级不同的值，
    // 唯一键 `(provider, model, effective_from)` 就永远不会冲突 ——
    // 那样这条用例会「绿得毫无意义」。
    const sql = `INSERT INTO model_prices
        (model_provider_id, model_id, display_name, input_price_per_1k, output_price_per_1k,
         currency, effective_from)
      VALUES ($1, 'm6', 'm6', '1', '1', 'CNY', '2026-06-01T00:00:00Z'::timestamptz)`;
    await client.query(sql, [providerId]);
    await expect(client.query(sql, [providerId])).rejects.toThrow(/duplicate key|唯一/);
  });
});

describe('准出 2 · 成本精度：numeric 口径，不出现浮点噪声', () => {
  it('单价 0.0015 / 0.002 × (1234, 567) token ⇒ 精确到 1e-6', async () => {
    // (1234 × 0.0015 + 567 × 0.002) / 1000
    //  = (1.851 + 1.134) / 1000 = 2.985 / 1000 = 0.002985
    const cost = computeCost({
      inputPricePer1k: 0.0015,
      outputPricePer1k: 0.002,
      tokensIn: 1234,
      tokensOut: 567,
    });
    expect(cost).toBeCloseTo(0.002985, 9);
    // 且必须是 8 位小数的干净值（numeric(18,8) 标度）
    expect(Number(cost.toFixed(8))).toBe(cost);
  });

  it('多次累加不产生浮点漂移（对比朴素浮点累加）', async () => {
    const price = { inputPricePer1k: 0.001, outputPricePer1k: 0.002 };
    const per = computeCost({ ...price, tokensIn: 1000, tokensOut: 500 });

    // 用与生产同一口径：每次算完都按 8 位标度对齐后再累加
    let acc = 0;
    for (let i = 0; i < 100; i++) acc = Number((acc + per).toFixed(8));

    // 100 次 × (1000×0.001 + 500×0.002)/1000 = 100 × (1+1)/1000 = 0.2
    expect(acc).toBe(0.2);
  });

  it('大单价大 token 不溢出精度', async () => {
    // 1,000,000 token × 0.5 元/1K = 500 元
    const cost = computeCost({
      inputPricePer1k: 0.5,
      outputPricePer1k: 0.5,
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(cost).toBe(1000);
  });
});
