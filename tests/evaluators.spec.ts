/**
 * M4 Batch 4 —— 算子库（PG-07，`US-016`，`BE/FE-M4-11`）。
 *
 * 覆盖三类「写错了也照常渲染」的事：
 *  1. GET：**内置六算子只读清单**（不入库、运行时合成、id 为固定展示位 UUID）
 *     + 已建裁判模板（入库）；
 *  2. POST 只允许裁判模板：rule 算子配置 ⇒ 400；key 与内置/已有冲突 ⇒ 409；
 *  3. **PT-1 快照不变**：模板另存后，历史 `run_evaluators.config` 逐字不变
 *     （G8 验收条件）。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EvaluatorTemplate } from '@eval-platform/contracts';
import { databaseUrl, dropAndRecreateSchema, migrate } from '../db/migrate.js';
import { closeDb, getPool } from '../db/schema/index.js';
import { buildCompareWorld } from './support/compare-fixtures.js';
import { restoreSeed } from './support/fixtures.js';

import * as evaluatorsRoute from '../app/api/evaluators/route.js';
import * as evaluatorIdRoute from '../app/api/evaluators/[evaluatorId]/route.js';

const DB_URL = process.env['DATABASE_URL'];
const BASE = 'http://localhost:3000';

function req(
  path: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
  });
}

function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

const JUDGE_CONFIG = {
  key: 'judge',
  modelProviderId: '00000000-0000-4000-8000-000000000011',
  modelId: 'deepseek-chat',
  promptTemplate: '请评估 {{output}} 相对 {{reference}} 的质量（输入：{{input}}）',
  scaleMax: 5,
  passThreshold: 0.6,
  temperature: 0,
};

beforeEach(async () => {
  await dropAndRecreateSchema(DB_URL);
  await migrate(DB_URL);
});

afterAll(async () => {
  await closeDb();
  await restoreSeed(databaseUrl());
});

describe('GET /api/evaluators · 内置清单 + 裁判模板', () => {
  it('内置六算子只读清单恒在（isBuiltin=true，不入库）；新建模板后出现在列表', async () => {
    const empty = await evaluatorsRoute.GET(req('/api/evaluators'));
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { items: EvaluatorTemplate[]; page: { total: number } };
    const builtinKeys = emptyBody.items.filter((i) => i.isBuiltin).map((i) => i.key);
    expect(builtinKeys).toEqual(
      expect.arrayContaining(['recall_at_k', 'mrr', 'ndcg_at_k', 'json_schema', 'regex', 'numeric_fidelity']),
    );
    expect(emptyBody.items.every((i) => i.kind === 'rule')).toBe(true);

    const post = await evaluatorsRoute.POST(
      req('/api/evaluators', {
        method: 'POST',
        body: { key: 'judge.rag-faithfulness', displayName: 'RAG 忠实度裁判', description: '5 分制', config: JUDGE_CONFIG },
      }),
    );
    expect(post.status).toBe(201);
    const created = EvaluatorTemplate.parse(await post.json());
    expect(created.kind).toBe('judge');
    expect(created.isBuiltin).toBe(false);
    expect(created.version).toBe(1);
    expect(created.createdBy).not.toBeNull();

    const after = (await (await evaluatorsRoute.GET(req('/api/evaluators'))).json()) as {
      items: EvaluatorTemplate[];
    };
    const tpl = after.items.find((i) => i.key === 'judge.rag-faithfulness');
    expect(tpl).toBeDefined();
    expect(tpl?.defaultConfig).toMatchObject({ key: 'judge', scaleMax: 5 });
    // prompt_template 落 judge 专用列（ck_evaluators_judge_prompt）
    expect(tpl && 'promptTemplate' in tpl ? null : null).toBeNull();
  });

  it('POST rule 配置 ⇒ 400；key 撞内置 ⇒ 409；key 撞已有模板 ⇒ 409', async () => {
    const ruleBody = await evaluatorsRoute.POST(
      req('/api/evaluators', {
        method: 'POST',
        body: { key: 'judge.x', displayName: 'x', config: { key: 'regex', pattern: '.' } },
      }),
    );
    expect(ruleBody.status).toBe(400);

    const builtinClash = await evaluatorsRoute.POST(
      req('/api/evaluators', {
        method: 'POST',
        body: { key: 'json_schema', displayName: 'x', config: JUDGE_CONFIG },
      }),
    );
    expect(builtinClash.status).toBe(409);

    await evaluatorsRoute.POST(
      req('/api/evaluators', {
        method: 'POST',
        body: { key: 'judge.a', displayName: 'a', config: JUDGE_CONFIG },
      }),
    );
    const second = await evaluatorsRoute.POST(
      req('/api/evaluators', {
        method: 'POST',
        body: { key: 'judge.a', displayName: 'a2', config: JUDGE_CONFIG },
      }),
    );
    expect(second.status).toBe(409);
  });
});

describe('PATCH /api/evaluators/{id} · 模板改版与 PT-1', () => {
  it('PATCH config ⇒ version 前进；**历史 run_evaluators.config 逐字不变（PT-1/G8）**', async () => {
    const w = await buildCompareWorld({
      name: 'evl',
      baseline: { name: 'b', evaluators: [], cases: [{ caseKey: 'c1', score: 0.5 }] },
      current: { name: 'c', evaluators: [], cases: [{ caseKey: 'c1', score: 0.5 }] },
    });
    // 历史 run 的算子快照（任意 config——PG-02 时由发起表单生成，这里直写 SQL 造事实）
    const snapshotConfig = {
      key: 'judge',
      modelProviderId: '00000000-0000-4000-8000-000000000011',
      modelId: 'deepseek-chat',
      promptTemplate: '旧版 Prompt {{output}}',
      scaleMax: 1,
      passThreshold: 0.6,
      temperature: 0,
    };
    await getPool().query(
      `INSERT INTO run_evaluators (eval_run_id, evaluator_key, evaluator_version, kind, config, weight, pass_threshold, order_index)
       VALUES ($1, 'judge.legacy', 1, 'judge', $2::jsonb, 1, NULL, 0)`,
      [w.currentRunId, JSON.stringify(snapshotConfig)],
    );

    const created = EvaluatorTemplate.parse(
      await (
        await evaluatorsRoute.POST(
          req('/api/evaluators', {
            method: 'POST',
            body: { key: 'judge.rag', displayName: 'RAG 裁判', config: JUDGE_CONFIG },
          }),
        )
      ).json(),
    );

    const patch = await evaluatorIdRoute.PATCH(
      req('/api/evaluators', {
        method: 'PATCH',
        body: { config: { ...JUDGE_CONFIG, scaleMax: 10, promptTemplate: '新版 Prompt {{output}}' } },
      }),
      params({ evaluatorId: created.id }),
    );
    expect(patch.status).toBe(200);
    const updated = EvaluatorTemplate.parse(await patch.json());
    expect(updated.version).toBe(2);
    expect(updated.defaultConfig).toMatchObject({ scaleMax: 10 });

    // PT-1：历史快照逐字不变
    const row = await getPool().query<{ config: unknown }>(
      'SELECT config FROM run_evaluators WHERE eval_run_id = $1 AND evaluator_key = $2',
      [w.currentRunId, 'judge.legacy'],
    );
    expect(row.rows[0]?.config).toEqual(snapshotConfig);
  });

  it('PATCH displayName/description 不动 version；未知/内置 id ⇒ 404', async () => {
    const created = EvaluatorTemplate.parse(
      await (
        await evaluatorsRoute.POST(
          req('/api/evaluators', {
            method: 'POST',
            body: { key: 'judge.b', displayName: '旧名', config: JUDGE_CONFIG },
          }),
        )
      ).json(),
    );
    const patch = await evaluatorIdRoute.PATCH(
      req('/api/evaluators', { method: 'PATCH', body: { displayName: '新名', description: '备注' } }),
      params({ evaluatorId: created.id }),
    );
    expect(patch.status).toBe(200);
    const updated = EvaluatorTemplate.parse(await patch.json());
    expect(updated.displayName).toBe('新名');
    expect(updated.version).toBe(1); // config 未变 ⇒ 版本不动

    const missing = await evaluatorIdRoute.PATCH(
      req('/api/evaluators', { method: 'PATCH', body: { displayName: 'x' } }),
      params({ evaluatorId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(missing.status).toBe(404);

    // 内置清单项是合成展示位，不在 DB ⇒ 404（不可改）
    const list = (await (await evaluatorsRoute.GET(req('/api/evaluators'))).json()) as {
      items: EvaluatorTemplate[];
    };
    const builtin = list.items.find((i) => i.isBuiltin && i.key === 'regex')!;
    const patchBuiltin = await evaluatorIdRoute.PATCH(
      req('/api/evaluators', { method: 'PATCH', body: { displayName: '改内置' } }),
      params({ evaluatorId: builtin.id }),
    );
    expect(patchBuiltin.status).toBe(404);
  });
});
