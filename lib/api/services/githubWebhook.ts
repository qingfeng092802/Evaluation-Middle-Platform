/**
 * Webhook 入站处理（M5 Batch 2，`US-022`；Q1=C 推入模式的入站半边）。
 *
 * 处理顺序即语义（`SPEC-M5.md` §附录 C / 验收条件 §4）：
 *  1. **先验签**：`X-Hub-Signature-256` = `sha256=<HMAC-SHA256(rawBody)>`，密钥取
 *     活跃集成的 `webhook_secret`，`timingSafeEqual` 常量时间比较——
 *     缺失 / 校验失败 → 401 且**不落任何 delivery 记录**（不暴露 run / 集成存在性）；
 *  2. **再幂等**：`X-GitHub-Delivery` 查既有账——命中 → 200 `{status:'DEDUPED', deduped:true}`
 *     （重放不再触发；账本不可变，读既有行）；
 *  3. 事件白名单：仅 `pull_request` 三态；其余事件（GitHub ping 等）验真后落账
 *     `SKIPPED_EVENT` 并 200（不占评测语义）；
 *  4. `closed` → `SKIPPED_CLOSED`（不建 run）；`opened / synchronize` → 映射
 *     `pr_trigger_rules`（label > pathGlobs > targetBranch）——零命中 → 202
 *     `SKIPPED_UNBOUND`；命中 → **占位触发**（`scheduleEvaluationRun`：Batch 3 接
 *     真实建 run + 出站回传）+ `TRIGGERED` 落账；
 *  5. `synchronize`：同 PR 历史触发的 **RUNNING** run 置 `cancel_requested=true`
 *     （Q3 协作式取消请求；实际终止由 worker 在 Case 边界完成，本批不杀进程）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PullRequestEvent } from '@eval-platform/contracts';
import type { WebhookResponse } from '@eval-platform/contracts';
import { UnauthorizedError } from '../http.js';
import {
  findDelivery,
  insertDelivery,
  listActiveWebhookSecrets,
  listEnabledTriggerRules,
  listPriorTriggeredRunIds,
  setCancelRequestedIfRunning,
} from '../../../db/repo/githubIntegrations.js';

export interface WebhookHeaders {
  readonly signature: string | null;
  readonly event: string | null;
  readonly deliveryId: string | null;
}

export interface WebhookOutcome {
  readonly httpStatus: 200 | 202;
  readonly body: WebhookResponse;
}

function parseSignature(signature: string): Buffer {
  const hex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length === 0) throw new UnauthorizedError('签名格式非法');
  return buf;
}

/** 入站主流程。验签失败抛 `UnauthorizedError`（路由层统一翻译 401）。 */
export async function processWebhook(headers: WebhookHeaders, rawBody: string): Promise<WebhookOutcome> {
  // 1. 验签（fail-closed：签名缺失 / 非法 / 不匹配一律 401，不落任何记录）
  if (headers.signature === null || headers.signature === '') {
    throw new UnauthorizedError('签名缺失');
  }
  const actual = parseSignature(headers.signature);
  const secrets = await listActiveWebhookSecrets();
  let integrationId: string | null = null;
  for (const { id, webhookSecret } of secrets) {
    const expected = createHmac('sha256', webhookSecret).update(rawBody).digest();
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      integrationId = id;
      break;
    }
  }
  if (integrationId === null) throw new UnauthorizedError('签名校验失败');

  // 2. 幂等（重放读既有账，不重复触发）
  const deliveryId = headers.deliveryId ?? '';
  const eventName = headers.event ?? '';
  const existing = await findDelivery(deliveryId);
  if (existing !== null) {
    return {
      httpStatus: 200,
      body: { status: 'DEDUPED', deduped: true, runId: existing.run_id },
    };
  }

  // 3. 事件白名单（非 pull_request：验真后落账 SKIPPED_EVENT，0024 枚举增补）
  if (eventName !== 'pull_request') {
    await insertDelivery({
      deliveryId,
      integrationId,
      event: eventName,
      signatureVerified: true,
      processedStatus: 'SKIPPED_EVENT',
      runId: null,
      payloadSummary: { event: eventName },
    });
    return { httpStatus: 200, body: { status: 'SKIPPED_EVENT', deduped: false, runId: null } };
  }

  // 4. 白名单 parse（GitHub 全量载荷在此剥离未知字段）
  const parsed = PullRequestEvent.safeParse(JSON.parse(rawBody) as unknown);
  if (!parsed.success) throw new UnauthorizedError('载荷不符合白名单形状');
  const event = parsed.data;
  const payloadSummary = {
    repo_full_name: event.repository.full_name,
    pr_number: event.number,
    head_sha: event.pull_request.head.sha,
    action: event.action,
  };

  // 5. closed → 跳过（不建 run）
  if (event.action === 'closed') {
    await insertDelivery({
      deliveryId,
      integrationId,
      event: eventName,
      signatureVerified: true,
      processedStatus: 'SKIPPED_CLOSED',
      runId: null,
      payloadSummary,
    });
    return { httpStatus: 200, body: { status: 'SKIPPED_CLOSED', deduped: false, runId: null } };
  }

  // 6. 映射（label > pathGlobs > targetBranch；多命中各触发一个 run）
  const rules = await listEnabledTriggerRules(event.repository.full_name);
  const matched = rules.filter((rule) => {
    if (rule.label !== null) {
      return event.pull_request.labels.some((l) => l.name === rule.label);
    }
    if (rule.pathGlobs !== null) {
      // 匹配需要变更文件列表（GitHub API 只读 files，Q4）——Batch 3 随 Installation
      // Token 接入；本批无法判定 ⇒ 不命中（fail-closed，不冒充命中）。
      return false;
    }
    return rule.targetBranch !== null && event.pull_request.base.ref === rule.targetBranch;
  });
  if (matched.length === 0) {
    await insertDelivery({
      deliveryId,
      integrationId,
      event: eventName,
      signatureVerified: true,
      processedStatus: 'SKIPPED_UNBOUND',
      runId: null,
      payloadSummary,
    });
    return { httpStatus: 202, body: { status: 'SKIPPED_UNBOUND', deduped: false, runId: null } };
  }

  // 7. Q3：synchronize → 同 PR 旧 RUNNING run 置取消请求位（实际终止由 worker 完成）
  if (event.action === 'synchronize') {
    const priorRunIds = await listPriorTriggeredRunIds(
      integrationId,
      event.repository.full_name,
      event.number,
    );
    for (const runId of priorRunIds) {
      await setCancelRequestedIfRunning(runId);
    }
  }

  // 8. 占位触发（Batch 3 接真实建 run + 出站回传）→ TRIGGERED 落账（多命中按规则拆行）
  const placeholderRunId = scheduleEvaluationRun(event, matched.map((r) => r.id));
  const deliveryIds =
    matched.length > 1 ? matched.map((r) => `${deliveryId}:${r.id}`) : [deliveryId];
  for (const [i] of matched.entries()) {
    await insertDelivery({
      deliveryId: deliveryIds[i] ?? deliveryId,
      integrationId,
      event: eventName,
      signatureVerified: true,
      processedStatus: 'TRIGGERED',
      runId: placeholderRunId,
      payloadSummary,
    });
  }

  return {
    httpStatus: 200,
    body: { status: 'TRIGGERED', deduped: false, runId: placeholderRunId },
  };
}

// ---------------------------------------------------------------------------
// 占位触发（Batch 3 接真实实现）
// ---------------------------------------------------------------------------

/**
 * **占位**：真实实现（Batch 3）= 按 rule.datasetId 解析最新版本 → 建 run
 * （`trigger_source='CI_WEBHOOK'`，0009 枚举已有）→ 等终态 → 出站回传（Q5）。
 * 本批只证明「映射命中 → 触发点被调用」，返回 null runId。
 */
function scheduleEvaluationRun(
  _event: PullRequestEvent,
  _ruleIds: readonly string[],
): string | null {
  console.log(
    `[github-webhook] 占位触发：规则 ${_ruleIds.join(',')}（PR #${String(_event.number)}，${_event.action}）——Batch 3 接真实建 run`,
  );
  return null;
}
