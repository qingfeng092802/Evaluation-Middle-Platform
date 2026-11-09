/**
 * E2E 失败路径驱动（`[INT-01]` DoD 第 3 条的可执行证据）：
 * **断开 fixture 网关**后发起评测 ⇒ 该批 `FAILED` 且 `score_overall IS NULL`。
 *
 * 前提：`npm run dev:all` 起来后，**单独停掉 fixture 进程**（`127.0.0.1:8787` 无响应）。
 * 用法：`npx tsx scripts/e2e-fail.ts`
 *
 * 为什么单独成脚本：这条路径要求网关**不在**，而正向脚本要求网关**在**。
 * 同一个进程里切换会引入时序不确定性（旧连接池可能仍持有 socket）。
 */
const BASE = process.env['E2E_BASE'] ?? 'http://127.0.0.1:3000';

async function j(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → ${String(res.status)}: ${JSON.stringify(body)}`);
  return body;
}

async function main(): Promise<void> {
  // 先确认网关真的不在：如果它还在，这条测试就没有意义
  const alive = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (alive) {
    throw new Error('fixture 网关仍在运行。请先停掉它再跑本脚本（否则断言的是正常路径）');
  }
  console.log('  ✓ 已确认 fixture 网关不可达');

  // 复用最近一份「E2E 验收集」与「E2E 自检目标」
  const ds = await j('/api/datasets?limit=50');
  const e2e = ds.items.find((d: any) => d.name.includes('E2E 验收集'));
  if (e2e === undefined) throw new Error('未找到 E2E 验收集，请先跑 scripts/e2e-demo.ts');
  const versions = await j(`/api/datasets/${e2e.id}/versions`);
  const v = versions.items[versions.items.length - 1];

  const targets = await j('/api/targets?limit=50');
  const t = targets.items.find((x: any) => x.name.startsWith('E2E 自检目标'));
  if (t === undefined || t.currentVersion === null) {
    throw new Error('未找到可用的 E2E 自检目标');
  }

  const run = await j('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E 断网自检运行（fixture 未启动）',
      datasetVersionId: v.id,
      targetVersionId: t.currentVersion.id,
      concurrency: 4,
      evaluators: [
        {
          config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true },
          weight: 1,
        },
      ],
    }),
  });
  console.log(`  → run ${run.id} PENDING（fixture 网关未启动）`);

  let detail = run;
  for (let i = 0; i < 90 && (detail.status === 'PENDING' || detail.status === 'RUNNING'); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    detail = await j(`/api/runs/${run.id}`);
    if (i % 15 === 0) {
      console.log(`  … ${String(i)}s ${detail.status} ${JSON.stringify(detail.counts)}`);
    }
  }
  console.log(
    '  final =',
    JSON.stringify({ status: detail.status, counts: detail.counts, metrics: detail.metrics }),
  );

  if (detail.status !== 'FAILED') throw new Error(`期望 FAILED，实际 ${detail.status}`);
  if (detail.metrics.scoreOverall !== null) {
    throw new Error(`期望 score_overall NULL，实际 ${String(detail.metrics.scoreOverall)}`);
  }
  if (detail.counts.failedCases !== 50) {
    throw new Error(`期望 50 条 FAILED，实际 ${String(detail.counts.failedCases)}`);
  }
  console.log('[e2e-fail] 断网路径通过：FAILED + score_overall=NULL + 50 条全失败');
}

main().catch((err: unknown) => {
  console.error('[e2e-fail] 失败：', err);
  process.exitCode = 1;
});
