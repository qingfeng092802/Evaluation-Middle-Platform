/**
 * GitHub Commit Status 回传（M5 Batch 3，`US-023`；Q5：Status 必交付）。
 *
 * ## 触发点（需求方 Batch 3 指令）
 * run 到达终态且**门禁求值完成后**——即 `evaluateRunGates` 内、新增判定落账之后
 * （惰性求值语义不变：由 CI 拉取触发；webhook 触发的 run 由其拉取方/后续批次的
 * 自动拉取覆盖）。
 *
 * ## 浮空 Promise 纪律（需求方 2026-11-19 批准）
 * 所有 GitHub 调用 **await 后才响应**——回传失败不阻塞主流程，但**必须先落账
 * 再返回**（`outbound_dispatch_logs`，channel_kind='github'，0025 枚举）。
 *
 * ## 隐私
 * 私钥解密仅发生在 `getInstallationToken` 一处；`payload`（留痕列）只存
 * `CommitStatusInput`（state/target_url/description/context），**无任何凭据**。
 */
import { CommitStatusInput } from '@eval-platform/contracts';
import {
  appRunBaseUrl,
  getInstallationToken,
  githubApiBase,
} from '../../github/app-auth.js';
import {
  findGithubOutboundContextForRun,
} from '../../../db/repo/githubIntegrations.js';
import { insertOutboundDispatchLog } from '../../../db/repo/gates.js';

export interface GithubOutboundContext {
  readonly integrationId: string;
  readonly repoFullName: string;
  readonly headSha: string;
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyCiphertext: string;
}

/** 状态映射：PASS/NO_GATE → success（NO_GATE 不冒充有门禁结论），FAIL → failure。 */
function statusOf(overall: string): 'success' | 'failure' {
  return overall === 'FAIL' ? 'failure' : 'success';
}

/**
 * 把门禁结果回传 GitHub Commit Status（对每个关联该 run 的集成 × 仓库 × sha 各一次）。
 *
 * 失败路径：网络异常 / 非 2xx → `outbound_dispatch_logs` 落 FAILED 行（带原因），
 * **绝不阻塞拉取响应、绝不改本地 run 状态**（渠道故障是常态——0021 同语义）。
 */
export async function dispatchGithubStatusForRun(input: {
  readonly runId: string;
  readonly runName: string;
  readonly overall: string;
}): Promise<void> {
  const contexts = await findGithubOutboundContextForRun(input.runId);
  for (const ctx of contexts) {
    const statusUrl = `${githubApiBase()}/repos/${ctx.repoFullName}/statuses/${ctx.headSha}`;
    const body = CommitStatusInput.parse({
      state: statusOf(input.overall),
      target_url: `${appRunBaseUrl()}/runs/${input.runId}`,
      description: `${input.runName}: ${input.overall}`.slice(0, 140),
      context: 'eval-platform',
    });
    let status: 'SUCCESS' | 'FAILED' = 'FAILED';
    let errorMessage: string | null = null;
    try {
      const token = await getInstallationToken({
        appId: ctx.appId,
        installationId: ctx.installationId,
        privateKeyCiphertext: ctx.privateKeyCiphertext,
      });
      const res = await fetch(statusUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      // fetch 对非 2xx 不抛错——显式判 ok（与 dispatchGateResult 同款纪律）
      if (res.ok) {
        status = 'SUCCESS';
      } else {
        status = 'FAILED';
        errorMessage = `HTTP ${String(res.status)}`;
      }
    } catch (err) {
      status = 'FAILED';
      errorMessage = (err as Error).message;
      console.warn(`[github-status] 回传失败（${ctx.repoFullName}@${ctx.headSha}）：`, errorMessage);
    }
    try {
      await insertOutboundDispatchLog({
        gateId: null,
        evalRunId: input.runId,
        channelKind: 'github',
        channelUrl: statusUrl,
        payload: body,
        status,
        errorMessage,
      });
    } catch (logErr) {
      console.warn('[github-status] 留痕写入失败：', (logErr as Error).message);
    }
  }
}
