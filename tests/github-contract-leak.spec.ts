/**
 * M5 推入模式契约的泄密扫描（Batch 1，契约层）。
 *
 * 准出：**凭据零明文**——GitHub 私钥（PEM）/ webhook_secret 只能出现在
 * `GithubIntegrationCreate` / `GithubIntegrationUpdate`（写入形状），
 * 读取形状 `GithubIntegration` 必须只有布尔位（`hasPrivateKey` / `hasWebhookSecret`）。
 *
 * 扫描方法与 `provider-secret-leak.spec.ts` 同哲学：
 *  - 不断言「有 `hasPrivateKey` 字段」（那几乎必然通过、什么也没证明），
 *    而是反向断言：往读取形状里**偷塞**明文凭据再 parse，序列化结果里
 *    **不得出现**哨兵串与凭据键名——将来谁往读取形状加一个凭据字段，这里立刻红。
 *  - API 级扫描（真实 `GET /api/integrations/github/{id}` 详情 + 404 错误响应）
 *    在 Batch 2 随集成配置路由落地（`tests/webhook-inbound.spec.ts`），本文件锁契约层。
 */
import { describe, expect, it } from 'vitest';
import {
  CommitStatusInput,
  GithubIntegration,
  GithubIntegrationCreate,
  GithubIntegrationUpdate,
  PRCommentInput,
  PullRequestEvent,
  WRITE_ONLY_FIELDS,
} from '@eval-platform/contracts';

/** 结构上不可能自然出现的哨兵：出现在任何读取形状的序列化结果里即判泄露。 */
const PEM_SENTINEL = 'SENTINEL-PEM-MUST-NOT-LEAK-3c7a';
const SECRET_SENTINEL = 'SENTINEL-WEBHOOK-SECRET-MUST-NOT-LEAK-9f1b';

const CREATE_BODY = {
  name: '主仓库集成',
  appId: '123456',
  installationId: '987654',
  privateKey: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_SENTINEL}\n-----END RSA PRIVATE KEY-----`,
  webhookSecret: SECRET_SENTINEL,
  repos: [{ owner: 'qingfeng092802', repo: 'demo' }],
};

describe('GithubIntegration · 读取形状零凭据（契约层泄密扫描）', () => {
  it('写入形状携带明文凭据（parse 保留——这是凭据唯一的合法出现处）', () => {
    const parsed = GithubIntegrationCreate.parse(CREATE_BODY);
    expect(parsed.privateKey).toContain(PEM_SENTINEL);
    expect(parsed.webhookSecret).toBe(SECRET_SENTINEL);
  });

  it('读取形状：偷塞明文凭据再 parse，序列化结果零泄露、只剩布尔位', () => {
    const malicious = {
      id: '00000000-0000-4000-8000-000000000001',
      name: '主仓库集成',
      kind: 'github_app',
      appId: '123456',
      installationId: '987654',
      hasPrivateKey: true,
      hasWebhookSecret: true,
      repos: [{ owner: 'o', repo: 'r' }],
      isActive: true,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
      // ↓ 攻击者/粗心开发者偷塞的凭据字段
      privateKey: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_SENTINEL}\n-----END RSA PRIVATE KEY-----`,
      webhookSecret: SECRET_SENTINEL,
      patCiphertext: 'v1:AAAA:BBBB:CCCC',
    };
    const parsed = GithubIntegration.parse(malicious);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(PEM_SENTINEL);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('webhookSecret');
    expect(serialized).not.toContain('patCiphertext');
    expect(parsed.hasPrivateKey).toBe(true);
    expect(parsed.hasWebhookSecret).toBe(true);
  });

  it('读取 shape 本身不含凭据键；布尔位与 kind 字面量在位', () => {
    expect('privateKey' in GithubIntegration.shape).toBe(false);
    expect('webhookSecret' in GithubIntegration.shape).toBe(false);
    expect('patCiphertext' in GithubIntegration.shape).toBe(false);
    expect('hasPrivateKey' in GithubIntegration.shape).toBe(true);
    expect('hasWebhookSecret' in GithubIntegration.shape).toBe(true);
    expect(GithubIntegration.shape.kind.value).toBe('github_app');
  });

  it('WRITE_ONLY_FIELDS 归档：Create/Update 的 privateKey 与 webhookSecret 在案', () => {
    expect(WRITE_ONLY_FIELDS['GithubIntegrationCreate']).toContain('privateKey');
    expect(WRITE_ONLY_FIELDS['GithubIntegrationCreate']).toContain('webhookSecret');
    expect(WRITE_ONLY_FIELDS['GithubIntegrationUpdate']).toContain('privateKey');
    expect(WRITE_ONLY_FIELDS['GithubIntegrationUpdate']).toContain('webhookSecret');
  });

  it('Update 形状：privateKey 可选重传（重置=密文覆写），省略即不改', () => {
    const rename = GithubIntegrationUpdate.parse({ name: '改名' });
    expect('privateKey' in rename).toBe(false);
    const rotate = GithubIntegrationUpdate.parse({ privateKey: `NEW-${PEM_SENTINEL}` });
    expect(rotate.privateKey).toContain(PEM_SENTINEL);
  });
});

describe('PullRequestEvent · 白名单纪律（未知字段剥离，全量载荷不落库）', () => {
  const githubLike = {
    action: 'synchronize',
    number: 7,
    repository: { id: 1, full_name: 'qingfeng092802/demo', node_id: 'x' },
    pull_request: {
      id: 2,
      head: { label: 'demo:feat', ref: 'feat/x', sha: 'abcdef1234abcdef1234' },
      base: { label: 'demo:main', ref: 'main', sha: '0f0f0f0f0f0f' },
      labels: [{ id: 3, name: 'eval-smoke' }],
      html_url: 'https://github.com/qingfeng092802/demo/pull/7',
      changed_files: 3,
    },
    // ↓ 全量载荷里存在、但本平台不需要的典型大字段
    sender: { login: 'someone' },
    installation: { id: 987654 },
    changes: {},
  };

  it('parse 剥离未知字段：序列化结果不含 sender/installation/changes', () => {
    const parsed = PullRequestEvent.parse(githubLike);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('sender');
    expect(serialized).not.toContain('installation');
    expect(serialized).not.toContain('changes');
    expect(serialized).not.toContain('changed_files');
    expect(parsed.action).toBe('synchronize');
    expect(parsed.pull_request.head.sha).toBe('abcdef1234abcdef1234');
    expect(parsed.pull_request.labels.map((l) => l.name)).toEqual(['eval-smoke']);
  });

  it('action 白名单：非三态拒绝', () => {
    expect(PullRequestEvent.safeParse({ ...githubLike, action: 'assigned' }).success).toBe(false);
  });
});

describe('出站声明（Q5：Status 必交付 / 评论顺延半批）', () => {
  it('CommitStatusInput：state 枚举 + description ≤140', () => {
    const ok = CommitStatusInput.parse({
      state: 'failure',
      target_url: 'https://ep.example/run/1',
      description: 'eval-platform: FAIL（score_overall 0.6 < 0.85）',
      context: 'eval-platform/冒烟集',
    });
    expect(ok.state).toBe('failure');
    expect(ok.target_url).toBe('https://ep.example/run/1');
    expect(CommitStatusInput.safeParse({ state: 'cancelled', target_url: 'https://x.dev', description: 'x', context: 'c' }).success).toBe(false);
  });

  it('PRCommentInput：body 必填', () => {
    expect(PRCommentInput.parse({ body: '## 🤖 评测门禁报告' }).body).toContain('🤖');
    expect(PRCommentInput.safeParse({}).success).toBe(false);
  });
});
