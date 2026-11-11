/**
 * API 集成测试（真库，**不 mock 数据库**）。
 *
 * 覆盖 `[BE-03]` DoD 的四条：
 *  1. `POST /api/runs` 的三条阻塞各一条，`code` 精确匹配 `BLOCKED_*`；
 *  2. AC-2 / AC-3：导入生成不可变版本、同指纹 409、坏行精确到行号（JSONL 47 / CSV 48）；
 *  3. worker 端到端：50 条 → 终态 `COMPLETED`、`score_overall = 0.6`、`pass_rate = 0.6`；
 *  4. 网关失败路径：`score IS NULL`，绝不落 0 分。
 *
 * 这里直接调用 Route Handler 的导出函数，而不是起一个 Next 服务器：
 * 路由体（契约 parse、错误映射、仓储调用）与真服务器完全同一份代码，
 * 少掉的是 HTTP 传输层——那一层不是本测试要验证的东西。
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect, databaseUrl, dropAndRecreateSchema, migrate, resetDatabase } from '../db/migrate.js';
import { closeDb } from '../db/schema/index.js';
import { runSeed } from '../scripts/seed.js';
import { FIXTURE_MODEL_ID } from '../db/seed/fixture-provider.js';

// Route Handlers（按 Next 的文件路由映射导入）
import * as datasetsRoute from '../app/api/datasets/route.js';
import * as datasetIdRoute from '../app/api/datasets/[id]/route.js';
import * as importValidateRoute from '../app/api/datasets/imports/validate/route.js';
import * as datasetImportsRoute from '../app/api/datasets/[id]/imports/route.js';
import * as versionsRoute from '../app/api/datasets/[id]/versions/route.js';
import * as versionDetailRoute from '../app/api/datasets/[id]/versions/[versionNo]/route.js';
import * as targetsRoute from '../app/api/targets/route.js';
import * as preflightRoute from '../app/api/runs/preflight/route.js';
import * as runsRoute from '../app/api/runs/route.js';
import * as runIdRoute from '../app/api/runs/[runId]/route.js';
import * as runCasesRoute from '../app/api/runs/[runId]/cases/route.js';
import * as runCaseDetailRoute from '../app/api/runs/[runId]/cases/[caseKey]/route.js';

// ---------------------------------------------------------------------------
// 请求构造小工具
// ---------------------------------------------------------------------------

const BASE = 'http://localhost:3000';

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : {
          body: JSON.stringify(init.body),
          headers: { 'content-type': 'application/json' },
        }),
  });
}

function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** AC-3 的 JSONL：50 行，第 47 行（1-based）缺 case_key 且 input 为空。 */
function buildJsonl47(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++) {
    if (i === 47) {
      lines.push(JSON.stringify({}));
      continue;
    }
    lines.push(
      JSON.stringify({
        case_key: `ac3-${String(i).padStart(4, '0')}`,
        input: { query: `第 ${i} 个问题` },
        reference: { golden_answer: `答案 ${i}` },
        retrieval: { relevant: [{ doc_id: `doc-${i}`, grade: 1 }] },
      }),
    );
  }
  return lines.join('\n');
}

/** 同一批数据的全通过 JSONL：49 行（第 47 行是合法的空 input 之外的正常行）。 */
function buildJsonl49(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 49; i++) {
    lines.push(
      JSON.stringify({
        case_key: `ok-${String(i).padStart(4, '0')}`,
        input: { query: `第 ${i} 个问题` },
        reference: { golden_answer: `答案 ${i}` },
        retrieval: { relevant: [{ doc_id: `doc-${i}`, grade: 1 }] },
      }),
    );
  }
  return lines.join('\n');
}

/** 同一批数据的 CSV：第 1 行表头，坏行落在数据第 47 条 ⇒ 物理行 48。 */
function buildCsv48(): string {  const lines: string[] = ['case_key,query,golden_answer,relevant'];
  for (let i = 1; i <= 50; i++) {
    if (i === 47) {
      lines.push(',,,');
      continue;
    }
    lines.push(
      `ac3-${String(i).padStart(4, '0')},第 ${i} 个问题,答案 ${i},"[{""doc_id"":""doc-${i}"",""grade"":1}]"`,
    );
  }
  return lines.join('\n');
}

/**
 * `.jsonl` 夹具的物理形状（snake_case，与文件一致）。
 * 契约的 `DatasetVersionCreate` 收 camelCase，故 `loadFixture50()` 负责转一次——
 * 不转的话 Zod 会静默丢弃 `case_key`，落库变成 hash 兜底键，测试看似通过实则错配。
 */
interface CaseRow {
  case_key: string;
  input: { query: string };
  reference: { golden_answer: string };
  retrieval: { relevant: { doc_id: string; grade: number }[] };
  metadata: { marker: string };
}

/** 契约形状的 Case（`DatasetVersionCreate.cases` 的元素）。 */
interface CaseInput {
  caseKey: string;
  input: { query: string };
  reference: { golden_answer: string };
  retrieval?: { relevant: { doc_id: string; grade: number }[] };
  metadata?: { marker: string };
}

async function loadFixture50(): Promise<CaseInput[]> {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const text = await readFile(join(here, 'fixtures', 'cases-50.jsonl'), 'utf8');
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const raw = JSON.parse(l) as CaseRow;
      return {
        caseKey: raw.case_key,
        input: raw.input,
        reference: raw.reference,
        retrieval: raw.retrieval,
        metadata: raw.metadata,
      };
    });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

let client: Client;

beforeAll(async () => {
  await dropAndRecreateSchema(databaseUrl());
  await migrate(databaseUrl());
  client = await connect();
});

afterAll(async () => {
  await client.end();
  await closeDb();
});

beforeEach(async () => {
  await resetDatabase(databaseUrl());
  await runSeed({ silent: true });
});

// ---------------------------------------------------------------------------
// AC-3 · 导入校验精确定位坏行
// ---------------------------------------------------------------------------

describe('AC-3 · 导入校验行号口径', () => {
  it('JSONL 报第 47 行，CSV 报第 48 行（表头计入物理行号）', async () => {
    const jsonlRes = await importValidateRoute.POST(
      req('/api/datasets/imports/validate', {
        method: 'POST',
        body: { content: buildJsonl47(), format: 'jsonl' },
      }),
    );
    expect(jsonlRes.status).toBe(200);
    const j = await json<{ okCount: number; failedCount: number; issues: { line: number; message: string }[]; canCommit: boolean }>(
      jsonlRes,
    );
    expect(j.okCount).toBe(49);
    expect(j.failedCount).toBe(1);
    expect(j.issues[0]?.line).toBe(47);
    expect(j.issues[0]?.message).toBe('缺少 case_key 且 input 为空');
    expect(j.canCommit).toBe(false);

    const csvRes = await importValidateRoute.POST(
      req('/api/datasets/imports/validate', {
        method: 'POST',
        body: { content: buildCsv48(), format: 'csv' },
      }),
    );
    expect(csvRes.status).toBe(200);
    const c = await json<{ okCount: number; failedCount: number; issues: { line: number }[]; canCommit: boolean }>(
      csvRes,
    );
    expect(c.okCount).toBe(49);
    expect(c.failedCount).toBe(1);
    expect(c.issues[0]?.line).toBe(48);
    expect(c.canCommit).toBe(false);
  });

  it('AC-3.5 绕过前端直接提交坏批次 ⇒ 不落任何行，版本列表仍为空', async () => {
    const created = await datasetsRoute.POST(
      req('/api/datasets', { method: 'POST', body: { name: '坏批次数据集' } }),
    );
    const ds = await json<{ id: string }>(created);

    const bad = await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, {
        method: 'POST',
        body: {
          source: 'import',
          cases: [{ input: { query: '' } }],
        },
      }),
      params({ id: ds.id }),
    );
    expect(bad.status).toBe(400);

    const list = await versionsRoute.GET(req(`/api/datasets/${ds.id}/versions`), params({ id: ds.id }));
    const body = await json<{ items: unknown[] }>(list);
    expect(body.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PG-05 区域 3 · 上传文件直接生成版本（`POST /api/datasets/{id}/imports`）
// ---------------------------------------------------------------------------

describe('PG-05 · 文件上传生成版本', () => {
  it('坏行 ⇒ 400 且带逐行 issue，一行都不落库', async () => {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: '上传坏行' } })),
    );

    const res = await datasetImportsRoute.POST(
      req(`/api/datasets/${ds.id}/imports`, {
        method: 'POST',
        body: { content: buildJsonl47(), format: 'jsonl' },
      }),
      params({ id: ds.id }),
    );
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; details?: { issues?: { line: number }[] } } }>(
      res,
    );
    expect(body.error.code).toBe('VALIDATION_FAILED');
    // 行号仍是服务端算好的物理行号，前端不再 ±1
    expect(body.error.details?.issues?.[0]?.line).toBe(47);

    const versions = await json<{ items: unknown[] }>(
      await versionsRoute.GET(req(`/api/datasets/${ds.id}/versions`), params({ id: ds.id })),
    );
    expect(versions.items).toHaveLength(0);
  });

  it('CSV 坏行报物理行 48（表头计入）', async () => {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: '上传坏 CSV' } })),
    );
    const res = await datasetImportsRoute.POST(
      req(`/api/datasets/${ds.id}/imports`, {
        method: 'POST',
        body: { content: buildCsv48(), format: 'csv' },
      }),
      params({ id: ds.id }),
    );
    expect(res.status).toBe(400);
    const body = await json<{ error: { details?: { issues?: { line: number }[] } } }>(res);
    expect(body.error.details?.issues?.[0]?.line).toBe(48);
  });

  it('全部通过 ⇒ 201 + 版本详情；同内容再传 ⇒ 409 且 details.existingVersionNo=1', async () => {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: '上传全通过' } })),
    );
    const content = buildJsonl49();

    const first = await datasetImportsRoute.POST(
      req(`/api/datasets/${ds.id}/imports`, {
        method: 'POST',
        body: { content, format: 'jsonl' },
      }),
      params({ id: ds.id }),
    );
    expect(first.status).toBe(201);
    const v1 = await json<{ versionNo: number; caseCount: number; immutable: boolean }>(first);
    expect(v1.versionNo).toBe(1);
    expect(v1.caseCount).toBe(49);
    expect(v1.immutable).toBe(true);

    const again = await datasetImportsRoute.POST(
      req(`/api/datasets/${ds.id}/imports`, {
        method: 'POST',
        body: { content, format: 'jsonl' },
      }),
      params({ id: ds.id }),
    );
    expect(again.status).toBe(409);
    const conflict = await json<{ error: { code: string; details?: { existingVersionNo?: number } } }>(
      again,
    );
    expect(conflict.error.code).toBe('CONFLICT');
    expect(conflict.error.details?.existingVersionNo).toBe(1);
  });

  it('列表聚合 latestSource 反映最新版本来源（不靠前端猜）', async () => {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: '来源聚合' } })),
    );
    // 建完容器但还没导入 ⇒ 来源为 null（不是伪造的 'import'）
    const before = await json<{ items: { id: string; latestSource: string | null }[] }>(
      await datasetsRoute.GET(req('/api/datasets?limit=50')),
    );
    expect(before.items.find((d) => d.id === ds.id)?.latestSource).toBeNull();

    await datasetImportsRoute.POST(
      req(`/api/datasets/${ds.id}/imports`, {
        method: 'POST',
        body: { content: buildJsonl49(), format: 'jsonl' },
      }),
      params({ id: ds.id }),
    );

    const after = await json<{ items: { id: string; latestSource: string | null }[] }>(
      await datasetsRoute.GET(req('/api/datasets?limit=50')),
    );
    expect(after.items.find((d) => d.id === ds.id)?.latestSource).toBe('import');
  });
});

// ---------------------------------------------------------------------------
// AC-2 · 不可变版本与指纹
// ---------------------------------------------------------------------------

describe('AC-2 · 一次导入 = 一个不可变版本', () => {
  it('首次导入 50 条 ⇒ v1；同文件再导 ⇒ 409 existingVersionNo=1；打乱行序仍 409', async () => {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: 'AC2 数据集' } })),
    );
    const cases = await loadFixture50();

    const first = await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, {
        method: 'POST',
        body: { source: 'import', cases },
      }),
      params({ id: ds.id }),
    );
    expect(first.status).toBe(201);
    const v1 = await json<{ versionNo: number; caseCount: number; contentHash: string }>(first);
    expect(v1.versionNo).toBe(1);
    expect(v1.caseCount).toBe(50);

    const detail = await json<{ immutable: boolean; cases: { caseKey: string; seq: number }[] }>(
      await versionDetailRoute.GET(req(`/api/datasets/${ds.id}/versions/1`), params({ id: ds.id, versionNo: '1' })),
    );
    expect(detail.immutable).toBe(true);
    expect(detail.cases).toHaveLength(50);
    // seq 0…49 且按 case_key 升序
    detail.cases.forEach((c, i) => expect(c.seq).toBe(i));
    const keys = detail.cases.map((c) => c.caseKey);
    expect([...keys].sort()).toEqual(keys);

    const again = await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, { method: 'POST', body: { source: 'import', cases } }),
      params({ id: ds.id }),
    );
    expect(again.status).toBe(409);
    const conflict = await json<{ error: { code: string; details?: { existingVersionNo?: number } } }>(again);
    expect(conflict.error.code).toBe('CONFLICT');
    expect(conflict.error.details?.existingVersionNo).toBe(1);

    // 打乱行序：content_hash 必须不变 ⇒ 仍然 409
    const shuffled = [...cases].reverse();
    const shuffledRes = await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, {
        method: 'POST',
        body: { source: 'import', cases: shuffled },
      }),
      params({ id: ds.id }),
    );
    expect(shuffledRes.status).toBe(409);

    const versions = await json<{ items: unknown[] }>(
      await versionsRoute.GET(req(`/api/datasets/${ds.id}/versions`), params({ id: ds.id })),
    );
    expect(versions.items).toHaveLength(1);
  });

  it('修改一条 query ⇒ 产生 v2，且 v1 的 50 行逐字节未变', async () => {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: 'AC2 变更数据集' } })),
    );
    const cases = await loadFixture50();

    await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, { method: 'POST', body: { source: 'import', cases } }),
      params({ id: ds.id }),
    );

    const before = await client.query<{ case_key: string; input: unknown }>(
      `SELECT c.case_key, c.input
         FROM dataset_cases c
         JOIN dataset_versions v ON v.id = c.dataset_version_id
        WHERE v.dataset_id = $1 AND v.version_no = 1
        ORDER BY c.seq`,
      [ds.id],
    );

    const changed = cases.map((c, i) =>
      i === 0 ? { ...c, input: { ...c.input, query: `${c.input.query}（已修改）` } } : c,
    );
    const res = await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, { method: 'POST', body: { source: 'import', cases: changed } }),
      params({ id: ds.id }),
    );
    expect(res.status).toBe(201);
    expect((await json<{ versionNo: number }>(res)).versionNo).toBe(2);

    const after = await client.query<{ case_key: string; input: unknown }>(
      `SELECT c.case_key, c.input
         FROM dataset_cases c
         JOIN dataset_versions v ON v.id = c.dataset_version_id
        WHERE v.dataset_id = $1 AND v.version_no = 1
        ORDER BY c.seq`,
      [ds.id],
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// R-6 · 三条阻塞校验
// ---------------------------------------------------------------------------

describe('R-6 · POST /api/runs 三条阻塞', () => {
  /** 准备一个 20 条带检索标注的版本 + 一个 T1 目标。 */
  async function setup(): Promise<{ datasetVersionId: string; targetVersionId: string }> {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: `阻塞测试-${Math.random()}` } })),
    );
    const cases = await loadFixture50();
    await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, { method: 'POST', body: { source: 'import', cases } }),
      params({ id: ds.id }),
    );
    const detail = await json<{ id: string }>(
      await versionDetailRoute.GET(req(`/api/datasets/${ds.id}/versions/1`), params({ id: ds.id, versionNo: '1' })),
    );

    const providers = await client.query<{ id: string }>(
      `SELECT id FROM model_providers WHERE is_active = true LIMIT 1`,
    );
    const providerId = providers.rows[0]?.id as string;

    const target = await json<{ currentVersion: { id: string } | null }>(
      await targetsRoute.POST(
        req('/api/targets', {
          method: 'POST',
          body: {
            name: `T1-${Math.random()}`,
            config: {
              kind: 't1_prompt',
              modelProviderId: providerId,
              modelId: FIXTURE_MODEL_ID,
              promptTemplate: '{{input}}',
              temperature: 0,
              maxTokens: 64,
            },
          },
        }),
      ),
    );
    const targetVersionId = target.currentVersion?.id as string;
    return { datasetVersionId: detail.id, targetVersionId };
  }

  const regexEvaluator = {
    config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true },
    weight: 1,
    passThreshold: 0.5,
  };

  it('BLOCKED_NO_EVALUATORS：evaluators 为空', async () => {
    const { datasetVersionId, targetVersionId } = await setup();
    const res = await runsRoute.POST(
      req('/api/runs', {
        method: 'POST',
        body: { name: '无算子', datasetVersionId, targetVersionId, concurrency: 4, evaluators: [] },
      }),
    );
    expect(res.status).toBe(400); // 契约 min(1) 先拦下
  });

  it('BLOCKED_NO_PROVIDER_CREDENTIALS：没有任何启用中的厂商', async () => {
    const { datasetVersionId, targetVersionId } = await setup();
    await client.query(`UPDATE model_providers SET is_active = false`);

    const res = await runsRoute.POST(
      req('/api/runs', {
        method: 'POST',
        body: {
          name: '无凭证',
          datasetVersionId,
          targetVersionId,
          concurrency: 4,
          evaluators: [regexEvaluator],
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BLOCKED_NO_PROVIDER_CREDENTIALS');
  });

  it('BLOCKED_NO_RETRIEVAL_ANNOTATION：选了检索算子但标注不全', async () => {
    // 造一个只有部分 Case 有 retrieval 的版本
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: '部分标注' } })),
    );
    const cases = await loadFixture50();
    const partial = cases.map((c, i) => {
      if (i === 0) {
        const { retrieval: _drop, ...rest } = c;
        return rest;
      }
      return c;
    });
    await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, { method: 'POST', body: { source: 'import', cases: partial } }),
      params({ id: ds.id }),
    );
    const version = await json<{ id: string }>(
      await versionDetailRoute.GET(req(`/api/datasets/${ds.id}/versions/1`), params({ id: ds.id, versionNo: '1' })),
    );

    const providers = await client.query<{ id: string }>(
      `SELECT id FROM model_providers WHERE is_active = true LIMIT 1`,
    );
    const target = await json<{ currentVersion: { id: string } | null }>(
      await targetsRoute.POST(
        req('/api/targets', {
          method: 'POST',
          body: {
            name: `T1-${Math.random()}`,
            config: {
              kind: 't1_prompt',
              modelProviderId: providers.rows[0]?.id,
              modelId: FIXTURE_MODEL_ID,
              promptTemplate: '{{input}}',
              temperature: 0,
              maxTokens: 64,
            },
          },
        }),
      ),
    );

    const res = await runsRoute.POST(
      req('/api/runs', {
        method: 'POST',
        body: {
          name: '缺标注',
          datasetVersionId: version.id,
          targetVersionId: target.currentVersion?.id,
          concurrency: 4,
          evaluators: [{ config: { key: 'recall_at_k', k: 5 }, weight: 1 }],
        },
      }),
    );
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('BLOCKED_NO_RETRIEVAL_ANNOTATION');
  });

  it('全部通过 ⇒ 201 且状态 PENDING、total_cases=50', async () => {
    const { datasetVersionId, targetVersionId } = await setup();
    const res = await runsRoute.POST(
      req('/api/runs', {
        method: 'POST',
        body: { name: '正常', datasetVersionId, targetVersionId, concurrency: 4, evaluators: [regexEvaluator] },
      }),
    );
    expect(res.status).toBe(201);
    const run = await json<{ status: string; counts: { totalCases: number }; evaluators: unknown[] }>(res);
    expect(run.status).toBe('PENDING');
    expect(run.counts.totalCases).toBe(50);
    expect(run.evaluators).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-6 · worker 端到端（真实 fixture 网关）
// ---------------------------------------------------------------------------

describe('AC-6 · 一次 50 条真栈跑批', () => {
  /** 起一个进程内 fixture 网关，把 provider 的 base_url 指过去。 */
  let gateway: { close: () => Promise<void> } | null = null;

  /**
   * 幂等启动：`PORT` / `FAIL_MODE` 都在模块加载时求值，重复 `listen` 同一端口会 EADDRINUSE，
   * 所以整个 describe 只起一次。错误注入走「换 base_url 到不监听的端口」，
   * 不走进程级开关（那需要重新 import 模块，vitest 会复用缓存）。
   */
  async function startGateway(): Promise<void> {
    if (!gateway) {
      process.env['FIXTURE_PORT'] = '8799';
      process.env['FIXTURE_FAIL_MODE'] = '';
      const { startFixtureGateway } = await import('../tools/fixture-gateway/index.js');
      gateway = await startFixtureGateway();
    }
    await client.query(`UPDATE model_providers SET base_url = 'http://127.0.0.1:8799'`);
  }

  afterAll(async () => {
    if (gateway) await gateway.close();
  });

  /** 顶层 `beforeEach` 会重跑种子（把 base_url 改回 8787），这里再指回来。 */
  beforeEach(async () => {
    await startGateway();
  });

  async function setupRun(passThreshold: number | null, extraCases?: CaseInput[]): Promise<string> {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: `AC6-${Math.random()}` } })),
    );
    const cases = extraCases ?? (await loadFixture50());
    await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, { method: 'POST', body: { source: 'import', cases } }),
      params({ id: ds.id }),
    );
    const version = await json<{ id: string }>(
      await versionDetailRoute.GET(req(`/api/datasets/${ds.id}/versions/1`), params({ id: ds.id, versionNo: '1' })),
    );
    const providers = await client.query<{ id: string }>(
      `SELECT id FROM model_providers WHERE is_active = true LIMIT 1`,
    );
    const target = await json<{ currentVersion: { id: string } | null }>(
      await targetsRoute.POST(
        req('/api/targets', {
          method: 'POST',
          body: {
            name: `T1-${Math.random()}`,
            config: {
              kind: 't1_prompt',
              modelProviderId: providers.rows[0]?.id,
              modelId: FIXTURE_MODEL_ID,
              promptTemplate: '{{input}}',
              temperature: 0,
              maxTokens: 64,
            },
          },
        }),
      ),
    );
    const evaluator =
      passThreshold === null
        ? { config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true }, weight: 1 }
        : {
            config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true },
            weight: 1,
            passThreshold,
          };
    const run = await json<{ id: string }>(
      await runsRoute.POST(
        req('/api/runs', {
          method: 'POST',
          body: {
            name: `run-${Math.random()}`,
            datasetVersionId: version.id,
            targetVersionId: target.currentVersion?.id,
            concurrency: 8,
            evaluators: [evaluator],
          },
        }),
      ),
    );
    return run.id;
  }

  it('50 条全部 OK ⇒ COMPLETED、score_overall=0.6、pass_rate=0.6、coverage=1、成本 0', async () => {
    const runId = await setupRun(0.5);

    const { processRun } = await import('../worker/loop.js');
    const { claimNextRun } = await import('../db/repo/queue.js');
    const claimed = await claimNextRun();
    expect(claimed?.id).toBe(runId);
    await processRun(runId);

    const run = await json<{
      status: string;
      counts: { totalCases: number; succeededCases: number; failedCases: number; skippedCases: number };
      metrics: { scoreOverall: number | null; passRate: number | null; coverage: number | null };
    }>(await runIdRoute.GET(req(`/api/runs/${runId}`), params({ runId })));

    expect(run.status).toBe('COMPLETED');
    expect(run.counts.succeededCases).toBe(50);
    expect(run.counts.failedCases).toBe(0);
    expect(run.metrics.scoreOverall).toBeCloseTo(0.6, 6);
    expect(run.metrics.passRate).toBeCloseTo(0.6, 6);
    expect(run.metrics.coverage).toBe(1);

    // 成本三列必须全 0（fixture 单价 0）
    const cost = await client.query<{ cost_target: string; cost_judge: string; cost_total: string; tokens_in_total: string }>(
      `SELECT cost_target, cost_judge, cost_total, tokens_in_total FROM eval_runs WHERE id = $1`,
      [runId],
    );
    expect(Number(cost.rows[0]?.cost_target)).toBe(0);
    expect(Number(cost.rows[0]?.cost_judge)).toBe(0);
    expect(Number(cost.rows[0]?.cost_total)).toBe(0);
    expect(Number(cost.rows[0]?.tokens_in_total)).toBeGreaterThan(0);

    // 库内复算：score_overall == avg(score) WHERE status='OK'
    const check = await client.query<{ avg: string | null; ok: string; total: string }>(
      `SELECT avg(score)::text AS avg,
              count(*) FILTER (WHERE status = 'OK')::text AS ok,
              (SELECT total_cases::text FROM eval_runs WHERE id = $1) AS total
         FROM eval_case_results WHERE eval_run_id = $1`,
      [runId],
    );
    expect(Number(check.rows[0]?.avg)).toBeCloseTo(0.6, 6);
    expect(Number(check.rows[0]?.ok)).toBe(50);

    // 明细接口
    const cases = await json<{ items: { status: string; score: number | null; costTotal: number }[] }>(
      await runCasesRoute.GET(req(`/api/runs/${runId}/cases?sortBy=score&order=asc&limit=200`), params({ runId })),
    );
    expect(cases.items).toHaveLength(50);
    expect(cases.items.every((c) => c.status === 'OK' && c.score !== null)).toBe(true);
    expect(cases.items.every((c) => c.costTotal === 0)).toBe(true);

    // PG-04 详情
    const detail = await json<{ hasBaseline: boolean; baselineResult: null; datasetCase: { caseKey: string } }>(
      await runCaseDetailRoute.GET(
        req(`/api/runs/${runId}/cases/case-0001`),
        params({ runId, caseKey: 'case-0001' }),
      ),
    );
    expect(detail.hasBaseline).toBe(false);
    expect(detail.baselineResult).toBeNull();
    expect(detail.datasetCase.caseKey).toBe('case-0001');
  });

  it('passThreshold=0（省略时的边界）⇒ pass_rate=1.0，score_overall 仍 0.6', async () => {
    const runId = await setupRun(0);
    const { processRun } = await import('../worker/loop.js');
    await import('../db/repo/queue.js').then((m) => m.claimNextRun());
    await processRun(runId);

    const run = await json<{ metrics: { scoreOverall: number | null; passRate: number | null } }>(
      await runIdRoute.GET(req(`/api/runs/${runId}`), params({ runId })),
    );
    expect(run.metrics.scoreOverall).toBeCloseTo(0.6, 6);
    expect(run.metrics.passRate).toBe(1);
  });

  it('省略 passThreshold ⇒ pass_rate 为 NULL（不是 0）', async () => {
    const runId = await setupRun(null);
    const { processRun } = await import('../worker/loop.js');
    await import('../db/repo/queue.js').then((m) => m.claimNextRun());
    await processRun(runId);

    const run = await json<{ metrics: { scoreOverall: number | null; passRate: number | null; coverage: number | null } }>(
      await runIdRoute.GET(req(`/api/runs/${runId}`), params({ runId })),
    );
    expect(run.metrics.scoreOverall).toBeCloseTo(0.6, 6);
    expect(run.metrics.passRate).toBeNull();
    expect(run.metrics.coverage).toBe(1);
  });

  it('网关 500 ⇒ 该 run FAILED 且 score_overall 为 NULL（不组装成 0 分）', async () => {
    // 换一个「必然失败」的网关：直接用不监听的端口 + 关掉 seed provider
    await client.query(`UPDATE model_providers SET base_url = 'http://127.0.0.1:1'`);

    const runId = await setupRun(0.5);
    const { processRun } = await import('../worker/loop.js');
    await import('../db/repo/queue.js').then((m) => m.claimNextRun());
    await processRun(runId);

    const run = await json<{
      status: string;
      metrics: { scoreOverall: number | null };
      counts: { succeededCases: number; failedCases: number };
    }>(await runIdRoute.GET(req(`/api/runs/${runId}`), params({ runId })));
    expect(run.status).toBe('FAILED');
    expect(run.metrics.scoreOverall).toBeNull();
    expect(run.counts.succeededCases).toBe(0);
    expect(run.counts.failedCases).toBe(50);

    const scores = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eval_case_results WHERE eval_run_id = $1 AND score IS NOT NULL`,
      [runId],
    );
    expect(Number(scores.rows[0]?.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 其它路由的基本正确性
// ---------------------------------------------------------------------------

describe('数据集 / 目标 CRUD', () => {
  it('数据集列表 / 详情 / PATCH 名称', async () => {
    const ds = await json<{ id: string; name: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: 'PATCH 测试' } })),
    );
    const patched = await json<{ name: string }>(
      await datasetIdRoute.PATCH(
        req(`/api/datasets/${ds.id}`, { method: 'PATCH', body: { name: 'PATCH 后' } }),
        params({ id: ds.id }),
      ),
    );
    expect(patched.name).toBe('PATCH 后');

    const list = await json<{ items: { id: string }[] }>(await datasetsRoute.GET(req('/api/datasets')));
    expect(list.items.some((d) => d.id === ds.id)).toBe(true);
  });

  it('PRE-FLIGHT：无标注版本 + 检索算子 ⇒ BLOCKED_NO_RETRIEVAL_ANNOTATION', async () => {
    const ds = await json<{ id: string }>(
      await datasetsRoute.POST(req('/api/datasets', { method: 'POST', body: { name: 'preflight 测试' } })),
    );
    const cases = (await loadFixture50()).map((c) => {
      const { retrieval: _drop, ...rest } = c;
      return rest;
    });
    await versionsRoute.POST(
      req(`/api/datasets/${ds.id}/versions`, { method: 'POST', body: { source: 'import', cases } }),
      params({ id: ds.id }),
    );
    const version = await json<{ id: string }>(
      await versionDetailRoute.GET(req(`/api/datasets/${ds.id}/versions/1`), params({ id: ds.id, versionNo: '1' })),
    );

    const pf = await json<{ blockers: string[]; canStart: boolean; retrievalReadiness: { state: string } }>(
      await preflightRoute.GET(
        req(`/api/runs/preflight?datasetVersionId=${version.id}&evaluatorKeys=recall_at_k,mrr`),
      ),
    );
    expect(pf.retrievalReadiness.state).toBe('NONE');
    expect(pf.blockers).toContain('BLOCKED_NO_RETRIEVAL_ANNOTATION');
    expect(pf.canStart).toBe(false);
  });
});
