/**
 * `GET/POST /api/pr-trigger-rules` —— PR → 评测集触发映射（M5，Q6：PR 专用冒烟集）。
 * 至少一种匹配策略（label / pathGlobs / targetBranch）由契约 refine 强制，
 * 数据库 `ck_pr_trigger_rules_strategy` 兜底。
 */
import type { NextRequest } from 'next/server';
import { PrTriggerRule, PrTriggerRuleListResponse } from '@eval-platform/contracts';
import { handle, ok, readJson } from '@/lib/api/http';
import { createTriggerRule, listTriggerRules } from '@/lib/api/services/prTriggerRules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return handle(async () => {
    const integrationId = new URL(req.url).searchParams.get('integrationId');
    return ok(PrTriggerRuleListResponse, await listTriggerRules(integrationId));
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(async () => ok(PrTriggerRule, await createTriggerRule(await readJson(req)), 201));
}
