/**
 * `GET/POST /api/integrations/github` —— GitHub 集成列表 / 创建（M5，`US-022`）。
 *
 * 凭据非对称：`POST` 请求体携带 PEM / webhookSecret 明文（唯一出现处），服务端立即
 * 加密落库；**任何响应（含错误响应）零凭据**——读取形状只有布尔位（泄密扫描锚点）。
 */
import type { NextRequest } from 'next/server';
import { GithubIntegration, GithubIntegrationListResponse } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { createIntegration, listIntegrations } from '@/lib/api/services/githubIntegrations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => ok(GithubIntegrationListResponse, await listIntegrations()));
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => ok(GithubIntegration, await createIntegration(await readJson(req)), 201));
}
