/**
 * M5 Batch 4 —— PG-09「GitHub 集成」区块的派生层单测 + 页面静态断言。
 *
 * 单测直测 `lib/ui/githubIntegrations.ts`（同 `settings-tabs-ui.spec` 范式）；
 * 静态断言锁「第五个 Tab 真的在页面上、区块接线真实、无 mock 顶包」。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GithubIntegrationCreate } from '@eval-platform/contracts';
import {
  canManageIntegrations,
  deliveryStatusLabel,
  githubCreateBody,
  githubFormError,
  manageIntegrationsDisabledHint,
  parseReposInput,
  reposSummary,
  triggerRuleCreateBody,
  triggerRuleFormError,
  type TriggerRuleDraft,
} from '@/lib/ui/githubIntegrations';

// ---------------------------------------------------------------------------
// parseReposInput / reposSummary
// ---------------------------------------------------------------------------

describe('parseReposInput · owner/repo 逐行解析', () => {
  it('多行解析为去空白数组', () => {
    expect(parseReposInput('o/r\n  x/y \n')).toEqual([
      { owner: 'o', repo: 'r' },
      { owner: 'x', repo: 'y' },
    ]);
  });

  it('无分隔符 / 多余斜杠 → null（无效行即整体拒绝，不静默丢行）', () => {
    expect(parseReposInput('just-a-name')).toBeNull();
    expect(parseReposInput('a/b/c')).toBeNull();
    expect(parseReposInput('o/r\nbad-line')).toBeNull();
  });

  it('空输入 → 空数组（由表单校验报「至少一个仓库」）', () => {
    expect(parseReposInput('')).toEqual([]);
  });
});

describe('reposSummary · 仓库摘要', () => {
  it('两个以内全列出，逗号分隔', () => {
    expect(reposSummary([{ owner: 'o', repo: 'r' }])).toBe('o/r');
    expect(reposSummary([{ owner: 'o', repo: 'r' }, { owner: 'x', repo: 'y' }])).toBe('o/r、x/y');
  });

  it('空数组 → 空串（调用方渲染「未绑定仓库」）', () => {
    expect(reposSummary([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// githubFormError / githubCreateBody
// ---------------------------------------------------------------------------

const VALID_DRAFT = {
  name: '主仓库集成',
  appId: '123456',
  installationId: '987654',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----',
  webhookSecret: 'sim-webhook-secret-0f1b',
  reposInput: 'o/r',
};

describe('githubFormError · 集成创建表单校验', () => {
  it('必填项逐个报错', () => {
    expect(githubFormError({ ...VALID_DRAFT, name: '' })).toContain('名称');
    expect(githubFormError({ ...VALID_DRAFT, appId: '' })).toContain('App ID');
    expect(githubFormError({ ...VALID_DRAFT, installationId: '' })).toContain('Installation ID');
    expect(githubFormError({ ...VALID_DRAFT, privateKey: '' })).toContain('私钥');
    expect(githubFormError({ ...VALID_DRAFT, webhookSecret: '' })).toContain('Webhook Secret');
    expect(githubFormError({ ...VALID_DRAFT, reposInput: '' })).toContain('仓库');
  });

  it('仓库行无效 → 报错并指出行格式', () => {
    expect(githubFormError({ ...VALID_DRAFT, reposInput: 'bad-line' })).toContain('owner/repo');
  });

  it('全部合法 → null', () => {
    expect(githubFormError(VALID_DRAFT)).toBeNull();
  });
});

describe('githubCreateBody · 请求体形状（过契约 parse + repos 解析）', () => {
  const UUID = '00000000-0000-4000-8000-000000000001';

  it('reposInput 解析进请求体且过 GithubIntegrationCreate 校验', () => {
    const body = githubCreateBody(VALID_DRAFT, UUID);
    expect(body).not.toBeNull();
    const parsed = GithubIntegrationCreate.parse(body);
    expect(parsed.name).toBe('主仓库集成');
    expect(parsed.repos).toEqual([{ owner: 'o', repo: 'r' }]);
  });

  it('reposInput 无效行 → 请求体为 null（调用方短路）', () => {
    expect(githubCreateBody({ ...VALID_DRAFT, reposInput: 'bad' }, UUID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TriggerRule
// ---------------------------------------------------------------------------

const RULE_DRAFT: TriggerRuleDraft = {
  datasetId: '',
  targetBranch: 'main',
  label: '',
};

describe('triggerRuleFormError · 触发规则校验', () => {
  it('datasetId 缺失 → 报错', () => {
    expect(triggerRuleFormError(RULE_DRAFT)).toContain('评测集');
  });

  it('三种策略全空 → 报错（契约 refine 同口径）', () => {
    expect(triggerRuleFormError({ datasetId: 'd', targetBranch: '', label: '' })).toContain('匹配策略');
  });

  it('有 branch 或 label → null', () => {
    expect(triggerRuleFormError({ datasetId: 'd', targetBranch: 'main', label: '' })).toBeNull();
    expect(triggerRuleFormError({ datasetId: 'd', targetBranch: '', label: 'eval-smoke' })).toBeNull();
  });

  it('triggerRuleCreateBody：空策略字段归一为 null（不送空串）', () => {
    const body = triggerRuleCreateBody(
      { datasetId: 'd', targetBranch: 'main', label: '' },
      'it-1',
      'o/r',
    );
    expect(body).toMatchObject({
      integrationId: 'it-1',
      repoFullName: 'o/r',
      targetBranch: 'main',
      label: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 角色语义（US-022 提案：GitHub 集成配置仅 ROLE-B，A 只读）
// ---------------------------------------------------------------------------

describe('canManageIntegrations / manageIntegrationsDisabledHint', () => {
  it('B 可操作，A 只读并给出指引', () => {
    expect(canManageIntegrations('B')).toBe(true);
    expect(canManageIntegrations('A')).toBe(false);
    expect(manageIntegrationsDisabledHint('A')).toContain('ROLE-B');
    expect(manageIntegrationsDisabledHint('B')).toBeNull();
  });
});

describe('deliveryStatusLabel · 投递状态文案', () => {
  it('六态全覆盖（0024 枚举）', () => {
    expect(deliveryStatusLabel('TRIGGERED')).toBe('已触发');
    expect(deliveryStatusLabel('SKIPPED_CLOSED')).toBe('跳过（PR 已关闭）');
    expect(deliveryStatusLabel('SKIPPED_UNBOUND')).toBe('跳过（未绑定仓库）');
    expect(deliveryStatusLabel('DEDUPED')).toBe('去重（重放）');
    expect(deliveryStatusLabel('REJECTED_SIGNATURE')).toBe('签名拒绝');
    expect(deliveryStatusLabel('SKIPPED_EVENT')).toBe('跳过（非评测事件）');
  });
});

// ---------------------------------------------------------------------------
// 页面静态断言（readFile 范式）
// ---------------------------------------------------------------------------

describe('settings 页静态断言（第五 Tab 接线）', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pageSrc = readFileSync(resolve(ROOT, 'app/settings/page.tsx'), 'utf8');
  const sectionSrc = readFileSync(resolve(ROOT, 'app/settings/github-integration-section.tsx'), 'utf8');

  it('page.tsx：GitHub 集成 Tab 接线 + 区块组件在位', () => {
    expect(pageSrc).toContain("'github'");
    expect(pageSrc).toContain('GithubIntegrationSection');
  });

  it('区块：打真实 API（集成 CRUD + 触发规则 + 投递历史），无 mock', () => {
    expect(sectionSrc).toContain('/api/integrations/github');
    expect(sectionSrc).toContain('/deliveries');
    expect(sectionSrc).toContain('/api/pr-trigger-rules');
    expect(sectionSrc).not.toContain('mockData');
    expect(sectionSrc).not.toContain('PlaceholderPage');
  });

  it('区块：凭据只写不读——私钥输入框在创建表单，卡片只渲染布尔位', () => {
    expect(sectionSrc).toContain('privateKey');
    expect(sectionSrc).toContain('hasPrivateKey');
  });
});
