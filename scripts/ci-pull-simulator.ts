/**
 * CI 拉取模拟器（Phase 2 · Batch 5 `[INT-M4-13]` 的本机预演）。
 *
 * 用法（三件套已由 `npm run dev:all` 起来后）：
 *     npx tsx scripts/ci-pull-simulator.ts
 *     （可选 CI_SIM_BASE 覆盖平台地址，默认 http://127.0.0.1:3000）
 *
 * **视角说明（读输出前先看这段）**：
 *  - §0–§2 是「平台侧」操作——模拟管理员经 UI/API 建规则、签发回调 Token；
 *  - §3 起是「外部 CI」视角——CI 只持明文 Token，只打 `GET /api/gates/results/{runId}`，
 *    拉 JSON、本地渲染 Markdown、决定是否阻断。这正是 Q1=C 裁定的边界：
 *    平台永不持有 GitHub PAT，也不写 PR 评论。
 *
 * 四个用例：
 *   A · 正常通过 —— 合法 Token 拉 PASS 信封；
 *   B · 被阻断   —— 合法 Token 拉 FAIL 信封（BLOCK 规则未过）；
 *   C · 鉴权失败 —— 错误 Token → 401 `UNAUTHORIZED`（不暴露 run 存在性）；
 *   D · 跨集错配 —— A 集的 Token 拉 B 集的 run → 401（Token 绑定其门禁的评测集）。
 *
 * 幂等可重跑：规则按名字复用（不重复建）；`gate_evaluations` 惰性求值 + 幂等复用，
 * 重复拉取返回同一信封；B 集按名字查找，已存在则直接复用。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GateResultEnvelope } from '@eval-platform/contracts';

const BASE = process.env['CI_SIM_BASE'] ?? 'http://127.0.0.1:3000';

// ---------------------------------------------------------------------------
// HTTP 小助手（e2e-demo 同款：ok 返回 JSON，非 ok 抛错；另给一个不抛的探针版）
// ---------------------------------------------------------------------------

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
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${String(res.status)}: ${JSON.stringify(body)}`);
  }
  return body;
}

/** 期望失败路径的探针：不抛错，返回状态码与响应体（用例 C / D 用）。 */
async function probe(path: string, init?: JsonInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function section(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

let checks = 0;
let failed = 0;
function expect(cond: boolean, msg: string): void {
  checks += 1;
  console.log(`${cond ? '  ✓' : '  ✗ 不符'} ${msg}`);
  if (!cond) {
    failed += 1;
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// §1 · renderMarkdown —— 纯函数：拉取 JSON → 可贴 PR 的 Markdown
// （Q4 裁定：Markdown 由 CI 侧渲染，平台只出 JSON——本函数就是「CI 侧」的最小实现）
// ---------------------------------------------------------------------------

const OVERALL_BADGE: Record<string, string> = {
  PASS: '✅ **通过**',
  FAIL: '❌ **阻断**',
  NO_GATE: '⚪ **无门禁规则**',
};

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : String(v);
}

/** 拉取信封（`GateResultEnvelope`）→ PR 评论 Markdown。纯字符串拼装，无副作用。 */
export function renderMarkdown(env: GateResultEnvelope): string {
  const badge = OVERALL_BADGE[env.overall] ?? env.overall;
  const lines: string[] = [];
  lines.push(`## 🤖 评测门禁报告 — ${env.runName}`);
  lines.push('');
  lines.push(`**总体结论：${badge}**（overall = \`${env.overall}\`）`);
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| score_overall | ${fmt(env.metrics.scoreOverall)} |`);
  lines.push(`| pass_rate | ${env.metrics.passRate === null ? '—（未设通过阈值）' : fmt(env.metrics.passRate)} |`);
  lines.push(`| coverage | ${fmt(env.metrics.coverage)} |`);
  lines.push(`| cost_total | ${fmt(env.metrics.costTotal)} |`);
  lines.push('');
  if (env.baseline === null) {
    lines.push('> ⚠️ **无已确认基线**：绝对指标判定不受影响；`regression_pct` 类规则整体跳过');
    lines.push('>（BL-2 fail-closed——跳过不等于通过，本报告不冒充有锚点的结论）。');
  } else {
    lines.push(
      `**基线**：run \`${env.baseline.evalRunId}\`（score_overall = ${fmt(env.baseline.scoreOverall)}，pass_rate = ${fmt(env.baseline.passRate)}）`,
    );
  }
  lines.push('');
  if (env.evaluations.length === 0) {
    lines.push('> ⚪ 未配置任何门禁规则，CI 应视为不阻断（`NO_GATE` 语义）。');
  } else {
    lines.push('| 门禁规则 | 动作 | 结果 | 指标 | 基线 → 当前 | Δ | 阈值 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const e of env.evaluations) {
      lines.push(
        `| ${e.gateName} | ${e.action} | ${e.passed ? '✅ 通过' : '❌ 未过'} | ${e.detail.metric} | ` +
          `${fmt(e.detail.baselineValue)} → ${fmt(e.detail.currentValue)} | ${fmt(e.detail.delta)} | ` +
          `${e.detail.op} ${e.detail.value} |`,
      );
    }
    lines.push('');
    // 逐条给「为什么没过」的可读原因（门禁是最需要可申诉的场景，契约同时存三方值）
    for (const e of env.evaluations) {
      if (!e.passed && e.action === 'BLOCK') {
        lines.push(
          `> ❌ **${e.gateName}**：${e.detail.metric} = ${fmt(e.detail.currentValue)} 已触发条件（${e.detail.op} ${e.detail.value}），动作 \`BLOCK\` → 总体 \`FAIL\`，请勿合流。`,
        );
      }
      if (!e.passed && e.action === 'WARN') {
        lines.push(
          `> ⚠️ **${e.gateName}**：${e.detail.metric} = ${fmt(e.detail.currentValue)} 已触发条件（${e.detail.op} ${e.detail.value}），动作 \`WARN\` 仅告警，不阻断。`,
        );
      }
      if (!e.passed && e.detail.currentValue === null) {
        lines.push(
          `> ⚠️ **${e.gateName}**：当前指标为 null（FAILED run / 未设阈值），**按 fail-closed 记未过，绝不冒充 0 分**。`,
        );
      }
    }
  }
  lines.push('');
  lines.push(
    `<sub>schemaVersion ${env.schemaVersion} · generatedAt ${env.generatedAt} · evalRun \`${env.evalRunId}\` · dataset \`${env.datasetId}\`@v(${env.datasetVersionId}) · 本报告由 CI 侧渲染（平台只交付 JSON——Q1=C 拉取模式，工程规则 §9）</sub>`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// §2 · 平台侧准备（模拟管理员）：数据集 / 规则 / 回调 Token
// ---------------------------------------------------------------------------

interface DatasetItem {
  readonly id: string;
  readonly name: string;
}

interface RunItem {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly datasetVersionId: string;
  readonly targetVersionId: string;
  readonly metrics: { readonly scoreOverall: number | null };
}

/**
 * A 集定位：**只认「E2E 验收集」**（e2e-demo 的产物，scoreOverall 恒为 0.6 可手算）。
 *
 * 为什么不能「取第一个有 COMPLETED run 的数据集」：本脚本会自建「CI-SIM B 集」，
 * 重跑后它们也带 COMPLETED run 且排在列表前面（created_at DESC）——把 B 当 A 用
 * 会让阈值断言（0.6 vs 0.85）与跨集用例全部翻车（2026-11-19 实测踩坑）。
 * 找不到种子集时自举：import cases-50 → 建 Target → 跑批 → 等终态（e2e-demo 同链路）。
 */
async function findDatasetWithCompletedRun(): Promise<{ datasetId: string; run: RunItem }> {
  const datasets = (await j('/api/datasets?limit=50')) as { items: DatasetItem[] };
  const candidates = datasets.items.filter((d) => d.name.includes('E2E 验收集'));
  for (const d of candidates) {
    const runs = (await j(`/api/runs?datasetId=${d.id}&limit=50`)) as { items: RunItem[] };
    const done = runs.items.find((r) => r.status === 'COMPLETED');
    if (done !== undefined) {
      console.log(`  ✓ A 集 = ${d.name}（${d.id}）`);
      return { datasetId: d.id, run: done };
    }
  }
  console.log('  · 没有「E2E 验收集」，自举一条（cases-50 → 目标 → 跑批）…');
  const jsonl = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'cases-50.jsonl'),
    'utf8',
  );
  const created = (await j('/api/datasets', {
    method: 'POST',
    body: JSON.stringify({ name: `E2E 验收集（50 条）${String(Date.now())}`, description: 'ci-pull-simulator 自举' }),
  })) as { id: string };
  const version = (await j(`/api/datasets/${created.id}/imports`, {
    method: 'POST',
    body: JSON.stringify({ content: jsonl, format: 'jsonl', source: 'import' }),
  })) as { id: string };
  const providers = (await j('/api/providers')) as { items: Array<{ id: string; name: string }> };
  const fixture = providers.items.find((p) => p.name.includes('fixture'))!;
  await j(`/api/providers/${fixture.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive: true }),
  });
  const target = (await j('/api/targets', {
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
  })) as { currentVersion: { id: string } };
  const run = (await j('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E 自检运行',
      datasetVersionId: version.id,
      targetVersionId: target.currentVersion.id,
      concurrency: 4,
      evaluators: [{ config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true }, weight: 1 }],
    }),
  })) as { id: string; status: string };
  for (let i = 0; i < 150; i += 1) {
    const detail = (await j(`/api/runs/${run.id}`)) as RunItem & { status: string };
    if (detail.status !== 'PENDING' && detail.status !== 'RUNNING') {
      console.log(`  ✓ 自举 run 终态：${detail.status}（runId=${run.id}）`);
      return { datasetId: created.id, run: detail };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('自举 run 150s 未到终态');
}

async function ensureGate(input: {
  datasetId: string;
  name: string;
  condition: { metric: string; op: '<' | '>'; value: number };
  action: 'BLOCK' | 'WARN';
}): Promise<{ id: string }> {
  const gates = (await j(`/api/gates?datasetId=${input.datasetId}`)) as {
    items: Array<{ id: string; name: string }>;
  };
  const existing = gates.items.find((g) => g.name === input.name);
  if (existing !== undefined) {
    console.log(`  ✓ 规则已存在，复用：${input.name}（${existing.id}）`);
    return existing;
  }
  const created = (await j('/api/gates', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      datasetId: input.datasetId,
      condition: input.condition,
      action: input.action,
      channels: [],
    }),
  })) as { id: string };
  console.log(`  ✓ 已创建规则：${input.name}（${created.id}）`);
  return created;
}

async function issueToken(gateId: string): Promise<string> {
  const res = (await j(`/api/gates/${gateId}/callback-token`, { method: 'POST', body: '{}' })) as {
    token: string;
  };
  return res.token;
}

/** 建一个 B 评测集 + 终态 run（e2e-demo 同链路的迷你版：2 条 FIXTURE-HIT 用例）。 */
async function provisionDatasetB(): Promise<{ datasetId: string; runId: string }> {
  console.log('  · B 集不存在，走真实导入 → 建目标 → 跑批链路（e2e-demo 迷你版）…');
  const created = (await j('/api/datasets', {
    method: 'POST',
    body: JSON.stringify({ name: `CI-SIM B 集 ${String(Date.now())}`, description: 'ci-pull-simulator 跨集错配用例' }),
  })) as { id: string };
  const jsonl = [
    { case_key: 'sim-b-1', input: { query: 'FIXTURE-HIT-sim-b-1' }, reference: { golden_answer: 'b1' }, metadata: {} },
    { case_key: 'sim-b-2', input: { query: 'FIXTURE-HIT-sim-b-2' }, reference: { golden_answer: 'b2' }, metadata: {} },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
  const version = (await j(`/api/datasets/${created.id}/imports`, {
    method: 'POST',
    body: JSON.stringify({ content: jsonl, format: 'jsonl', source: 'import' }),
  })) as { id: string; versionNo: number };

  const providers = (await j('/api/providers')) as { items: Array<{ id: string; name: string }> };
  const fixture = providers.items.find((p) => p.name.includes('fixture'))!;
  // seed 对 provider 激活态是破坏性的（M2 合并说明披露：每次 dev:all / db:seed 把
  // is_active 重置为 false）——跑批前置校验要求厂商在位，先幂等激活。
  await j(`/api/providers/${fixture.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive: true }),
  });
  console.log('  ✓ fixture 厂商已激活（is_active=true，抵消 seed 的破坏性重置）');
  const target = (await j('/api/targets', {
    method: 'POST',
    body: JSON.stringify({
      name: `CI-SIM B 目标 ${String(Date.now())}`,
      config: {
        kind: 't1_prompt',
        modelProviderId: fixture.id,
        modelId: 'fixture-echo-1',
        promptTemplate: '{{input}}',
        temperature: 0,
        maxTokens: 64,
      },
    }),
  })) as { currentVersion: { id: string } };

  await j(`/api/runs/preflight?datasetVersionId=${version.id}&evaluatorKeys=regex`);
  const run = (await j('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'CI-SIM B 运行',
      datasetVersionId: version.id,
      targetVersionId: target.currentVersion.id,
      concurrency: 2,
      evaluators: [{ config: { key: 'regex', pattern: 'FIXTURE-HIT-', caseSensitive: false, shouldMatch: true }, weight: 1 }],
    }),
  })) as { id: string; status: string };

  for (let i = 0; i < 90; i += 1) {
    const detail = (await j(`/api/runs/${run.id}`)) as { status: string };
    if (detail.status !== 'PENDING' && detail.status !== 'RUNNING') {
      console.log(`  ✓ B 集 run 终态：${detail.status}（runId=${run.id}）`);
      return { datasetId: created.id, runId: run.id };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('B 集 run 90s 未到终态');
}

async function ensureDatasetB(): Promise<{ datasetId: string; runId: string }> {
  const datasets = (await j('/api/datasets?limit=50')) as { items: DatasetItem[] };
  const existing = datasets.items.find((d) => d.name.startsWith('CI-SIM B 集') && !d.name.includes('废弃'));
  if (existing !== undefined) {
    const runs = (await j(`/api/runs?datasetId=${existing.id}&limit=50`)) as { items: RunItem[] };
    const done = runs.items.find((r) => r.status === 'COMPLETED' || r.status === 'PARTIAL_FAILED');
    if (done !== undefined) {
      console.log(`  ✓ B 集已存在，复用（${existing.id}，runId=${done.id}）`);
      return { datasetId: existing.id, runId: done.id };
    }
  }
  return provisionDatasetB();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  section('§0 · 前置检查（平台可达）');
  const datasets = (await j('/api/datasets?limit=50')) as { items: DatasetItem[] };
  expect(datasets.items.length > 0, `平台可达，评测集 ${String(datasets.items.length)} 个`);

  section('§1 · 平台侧：定位 A 集（带 COMPLETED run）与两条规则、签发回调 Token');
  const { datasetId, run } = await findDatasetWithCompletedRun();
  console.log(`  ✓ A 集 = ${datasetId}；目标 run = ${run.id}（${run.name}，scoreOverall=${String(run.metrics.scoreOverall)}）`);

  const gatePass = await ensureGate({
    datasetId,
    name: 'CI-SIM · 放行线（score_overall 不低于 0.1 即过）',
    condition: { metric: 'score_overall', op: '<', value: 0.1 },
    action: 'BLOCK',
  });
  const gateBlock = await ensureGate({
    datasetId,
    name: 'CI-SIM · 阻断线（score_overall < 0.85 触发）',
    condition: { metric: 'score_overall', op: '<', value: 0.85 },
    action: 'BLOCK',
  });
  const tokenPass = await issueToken(gatePass.id);
  const tokenBlock = await issueToken(gateBlock.id);
  console.log('  ✓ 已签发两枚回调 Token（明文仅本次可见；平台只存 SHA-256）');

  // -------------------------------------------------------------------------

  section('§3 · 用例 A（外部 CI 视角）：合法 Token 拉取 → PASS');
  // 门禁求值是「对该数据集上**所有启用规则**」一起算的——阻断线不关，0.6 的 run
  // 永远 overall=FAIL，用例 A 无从成立。所以先临时停用阻断线（PATCH isActive=false），
  // 用例 B 再启用：这本身就是 PG-09 规则启停的真实 API 路径。
  await j(`/api/gates/${gateBlock.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive: false }),
  });
  console.log('  ✓ 阻断线已临时停用（isActive=false）——本用例只验证放行线');
  const pullA = await probe(`/api/gates/results/${run.id}`, {
    headers: { 'x-callback-token': tokenPass },
  });
  expect(pullA.status === 200, `HTTP ${String(pullA.status)}（期望 200）`);
  const envA = GateResultEnvelope.parse((pullA.body as { gateResult: unknown }).gateResult);
  expect(envA.overall === 'PASS', `overall=${envA.overall}（期望 PASS：0.6 未触发 < 0.1 的条件）`);
  console.log('— 拉取到的 JSON（原样）—');
  console.log(JSON.stringify({ gateResult: envA }, null, 2));
  console.log('— renderMarkdown(env) 渲染结果（可直接贴 PR）—');
  console.log(renderMarkdown(envA));

  section('§3 · 用例 B（外部 CI 视角）：合法 Token 拉取 → FAIL（BLOCK 规则未过）');
  await j(`/api/gates/${gateBlock.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive: true }),
  });
  console.log('  ✓ 阻断线已重新启用（isActive=true）');
  const pullB = await probe(`/api/gates/results/${run.id}`, {
    headers: { 'x-callback-token': tokenBlock },
  });
  expect(pullB.status === 200, `HTTP ${String(pullB.status)}（期望 200——被阻断不是被拒收）`);
  const envB = GateResultEnvelope.parse((pullB.body as { gateResult: unknown }).gateResult);
  expect(envB.overall === 'FAIL', `overall=${envB.overall}（期望 FAIL：0.6 < 0.85 触发 BLOCK）`);
  const failedRule = envB.evaluations.find((e) => !e.passed);
  expect(failedRule !== undefined && failedRule.detail.currentValue === 0.6, '失败规则明细：currentValue=0.6、delta 可复算');
  console.log(renderMarkdown(envB));

  section('§3 · 用例 C（外部 CI 视角）：错误 Token → 401');
  const pullC = await probe(`/api/gates/results/${run.id}`, {
    headers: { 'x-callback-token': 'ci-sim-wrong-token-not-issued' },
  });
  expect(pullC.status === 401, `HTTP ${String(pullC.status)}（期望 401）`);
  const errC = (pullC.body as { error?: { code?: string; message?: string } }).error;
  expect(errC?.code === 'UNAUTHORIZED', `error.code=${String(errC?.code)}（期望 UNAUTHORIZED）`);
  console.log('— 401 响应 JSON（原样）—');
  console.log(JSON.stringify(pullC.body, null, 2));

  section('§3 · 用例 D（外部 CI 视角）：A 集 Token 拉 B 集 run → 401 跨集错配');
  const b = await ensureDatasetB();
  console.log(`  · 目标：B 集 run ${b.runId}（${b.datasetId}），持 A 集 Token`);
  const pullD = await probe(`/api/gates/results/${b.runId}`, {
    headers: { 'x-callback-token': tokenPass },
  });
  expect(pullD.status === 401, `HTTP ${String(pullD.status)}（期望 401——Token 绑定 A 集，跨集即越权）`);
  const errD = (pullD.body as { error?: { code?: string; message?: string } }).error;
  expect(errD?.code === 'UNAUTHORIZED', `error.code=${String(errD?.code)}（期望 UNAUTHORIZED）`);
  console.log('— 401 响应 JSON（原样）—');
  console.log(JSON.stringify(pullD.body, null, 2));

  section('§4 · 结论');
  const total = 11; // 断言总数（§0:1 + A:2 + B:3 + C:2 + D:2 + 本条收尾:1）
  expect(failed === 0, `共 ${String(total)} 项断言，失败 ${String(failed)} 项（调用 ${String(checks)} 次）`);
  console.log(`\n[ci-sim] 完成：A/B/C/D 四用例 + Markdown 渲染演示。退出码 ${String(process.exitCode ?? 0)}`);
}

main().catch((err: unknown) => {
  console.error('[ci-sim] 失败：', err);
  process.exitCode = 1;
});
