/**
 * E2E 正向驱动 · 保留为可复跑的自检脚本（`[INT-01]` 交付物 2 的可执行证据）。
 *
 * 用法（三件套已由 `npm run dev:all` 起来后）：
 *     npx tsx scripts/e2e-demo.ts
 *
 * 走**真实 HTTP 接口**，与浏览器点出来完全同一条路径：
 *   建评测集 → 导入 50 条验收集 → 取 fixture 厂商 → 建 T1 目标
 *   → preflight → POST /api/runs → 轮询终态 → 拉明细与 Case 详情。
 *
 * 断言口径全部来自 `SPEC-M1` §3.2（可手算）：前 30 条含 `FIXTURE-HIT-`，
 * 因此 `scoreOverall` 必须是 `30/50 = 0.6`，与时间、并发、机器无关。
 *
 * 保留而不删：验收 Agent 与后续里程碑都需要一条「不点浏览器也能证明链路通」的入口。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env['E2E_BASE'] ?? 'http://127.0.0.1:3000';

interface JsonInit extends RequestInit {
  readonly body?: string;
}

async function j(path: string, init?: JsonInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} → ${String(res.status)}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  // 1. 建评测集 + 导入 50 条验收集（AC-6 同一夹具）
  const cases50 = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'cases-50.jsonl'),
    'utf8',
  );
  const created = await j('/api/datasets', {
    method: 'POST',
    body: JSON.stringify({ name: `E2E 验收集（50 条）${String(Date.now())}`, description: 'INT-01 端到端自检' }),
  });
  console.log(`  ✓ 创建评测集 ${created.id}`);

  const version = await j(`/api/datasets/${created.id}/imports`, {
    method: 'POST',
    body: JSON.stringify({ content: cases50, format: 'jsonl', source: 'import' }),
  });
  assert((version.cases ?? []).length === 50 || version.caseCount === 50, `导入生成 v${String(version.versionNo)}：50 条`);

  // 2. fixture 厂商
  const providers = await j('/api/providers');
  const fixture = providers.items.find((p: any) => p.name.includes('fixture'));
  assert(fixture !== undefined, '找到种子厂商「本地离线自检（fixture）」');

  // 3. 创建 T1 目标（页面同一路径）
  const target = await j('/api/targets', {
    method: 'POST',
    body: JSON.stringify({
      name: `E2E 自检目标 ${String(Date.now())}`,
      config: {
        kind: 't1_prompt',
        modelProviderId: fixture.id,
        modelId: 'fixture-echo-1',
        promptTemplate: '{{input}}',
        temperature: 0,
        maxTokens: 64,
      },
    }),
  });
  assert(target.currentVersion !== null, `创建 Target 成功并生成 v${String(target.currentVersionNo)}`);

  // 4. 预检
  const pre = await j(`/api/runs/preflight?datasetVersionId=${version.id}&evaluatorKeys=regex`);
  assert(pre.canStart === true, `preflight 通过（blockers=${JSON.stringify(pre.blockers)}）`);

  // 5. 发起运行
  const run = await j('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E 自检运行',
      datasetVersionId: version.id,
      targetVersionId: target.currentVersion.id,
      concurrency: 4,
      evaluators: [
        {
          config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true },
          weight: 1,
        },
      ],
    }),
  });
  console.log(`  → run ${run.id} 状态 ${run.status}`);

  // 6. 等终态
  let detail = run;
  for (let i = 0; i < 120 && (detail.status === 'PENDING' || detail.status === 'RUNNING'); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    detail = await j(`/api/runs/${run.id}`);
    if (i % 10 === 0) {
      console.log(`  … ${String(i)}s status=${detail.status} ${JSON.stringify(detail.counts)}`);
    }
  }
  assert(detail.status === 'COMPLETED', `run 进入终态 COMPLETED（实际 ${detail.status}）`);

  // 7. 指标与明细（AC-6 口径）
  console.log('  metrics =', JSON.stringify(detail.metrics));
  console.log('  counts  =', JSON.stringify(detail.counts));
  assert(detail.counts.totalCases === 50, 'totalCases=50');
  assert(detail.counts.succeededCases === 50, 'succeededCases=50（fixture 全回显成功）');
  assert(
    detail.metrics.scoreOverall !== null && Math.abs(detail.metrics.scoreOverall - 0.6) < 1e-6,
    `scoreOverall=0.6（实际 ${String(detail.metrics.scoreOverall)}）`,
  );
  assert(detail.metrics.passRate === null, '未设通过阈值 ⇒ passRate=NULL（不拿 0 冒充）');
  assert(detail.metrics.coverage === 1, 'coverage=1');
  assert(detail.metrics.costTotal === 0, '成本全 0（fixture 单价 0）');

  const cases = await j(`/api/runs/${run.id}/cases?limit=200&sortBy=score&order=asc`);
  assert(cases.items.length === 50, '明细接口返回 50 条');
  assert(
    cases.items.every((c: any) => c.status === 'OK'),
    '全部 Case 状态 OK',
  );
  const hit = cases.items.filter((c: any) => c.score === 1).length;
  assert(hit === 30, `分数分布 = 30 条 1.0 / 20 条 0.0（实际 1.0 的有 ${String(hit)} 条）`);

  const one = await j(
    `/api/runs/${run.id}/cases/${encodeURIComponent(cases.items[0].caseKey)}`,
  );
  assert(
    typeof one.result.outputText === 'string' && one.result.outputText.startsWith('[fixture]'),
    'Case 详情输出为 fixture 回显',
  );

  console.log('[e2e] 端到端全链路通过');
  console.log(`[e2e] runId=${run.id}`);
}

main().catch((err: unknown) => {
  console.error('[e2e] 失败：', err);
  process.exitCode = 1;
});
