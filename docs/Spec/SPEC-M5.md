# SPEC-M5 · 推入模式（原生 GitHub Webhook）立项草案与安全模型推演

> **状态**：**v0.2 —— Q0–Q6 七项已于 2026-11-19 全部裁定回填**（见 §1 各条「裁定」行与 §附录 A）。
> Q0 的两处事实文件修订（`工程规则.md` §9 / `pages-and-flows.md` PG-09 边界句）**条文已定稿、
> 随第一笔 `contracts(M5)` 入库，不提前提交**（需求方指令）。**Batch 1 未启动**——需求方放行后才
> 动契约与代码。此前 v0.1 为纯草案（Phase 3 纪律：零业务代码、零路由/服务新增；契约与 DDL 均为
> 草案，裁定后以 `contracts(M5)` 单独成笔入库）。
> **上位事实源**：`docs/Spec/milestones.md`（止于 M4——增补义务见 §5）、`docs/facts/user-stories.md`
> `US-018`（GitHub PR 部分 M4 时顺延，本 SPEC 即其激活提案）、`docs/facts/pages-and-flows.md`
> PG-09 GitHub 边界句、`docs/工程规则.md` §9（**本 SPEC 记录对其中一条红线的推翻裁定，见 Q0**）、
> `src/contracts/`（GateChannel 枚举 / gate_evaluations 不可变 / db-schema 注册表）、
> `docs/Spec/SPEC-M4.md` §1.10（Q1=C 拉取模式，推入模式顺延至此）、`docs/Spec/ci-pull-simulator.ts`
> 实跑结论（拉取契约边界成立；「门禁规则整体计算」行为实测确认）。
> **冲突时以事实文档为准**；本文件与口头预期的差异**不静默吞掉**，全部进 §5 差异表与 §1 待确认。
>
> 阅读顺序（`AGENTS.md` §一）：`AGENTS.md` → `docs/工程规则.md` → `docs/facts/` → `src/contracts/` → 本文件。

---

## 0. 全局前置检查（Batch 1 开始前逐条确认）

| # | 检查项 | 判定方法 | 状态 |
|---|---|---|---|
| 1 | M4 已合并入 `main` 并打 `v0.1.0-m4` | `git tag -l` 含 `v0.1.0-m4`；origin 三个里程碑 tag 齐 | ✅ 已核实（2026-11-19，merge `a74c789`） |
| 2 | **`工程规则.md` §9 红线修订入库**（「不在项目中配置 GitHub PAT」→「GitHub 凭证受控持有」，修订条文见 §1-Q0 附） | 读 §9 原文 | 🟡 **已批准（Q0，2026-11-19）、条文定稿——随第一笔 `contracts(M5)` 入库，不提前提交** |
| 3 | `pages-and-flows.md` PG-09 GitHub 边界句同步修订 | 读 PG-09 边界段 | 🟡 同行 2：已批准、条文定稿，随 `contracts(M5)` 入库 |
| 4 | 本 SPEC §1 待确认（Q1–Q6）全部裁定 | 见 §1 | ✅ **已裁定（2026-11-19，回填见 §附录 A）** |
| 5 | `milestones.md` 增补 M5 行 + 故事归属提案（US-022 webhook 集成 / US-023 结果回传，见 §5） | 读 milestones | ⬜ 待执行（随 `contracts(M5)` 或 Batch 1 入库） |
| 6 | 拉取模式契约边界已实测成立（推入模式的回传与判定语义复用它） | `scripts/ci-pull-simulator.ts` 实跑 | ✅ 11 项断言 0 失败（`572f36a`，2026-11-19） |
| 7 | 「门禁规则整体计算」行为已实测留档（Q6 的背景事实） | simulator 用例 A/B 复现：阻断线启用 ⇒ 该集全部 run FAIL | ✅ 已留档（`572f36a` 提交信息 + 本 SPEC §1-Q6） |

---

## 1. 红线推翻与前置裁定（Q0–Q6，**2026-11-19 已全部裁定**，回填见各条「裁定」行与 §附录 A）

> 裁定原则（承 SPEC-M4 §1）：凡与事实源冲突的预期，**先指出冲突、给出选项与建议、停下等裁定**
> ——不静默改架构，也不静默缩范围。

### Q0 · 推翻「平台永不持有 GitHub PAT」红线（治理动作，阻塞全部批次）

**背景**：三处事实源锁死了推入模式的前提——
① `工程规则.md` §9：「**不在项目中配置 GitHub PAT**：代码管理走本机已有 Git 命令行」；
② `pages-and-flows.md` PG-09：「平台侧**永不持有、永不输入任何 GitHub PAT**……本 Tab 不出现任何 GitHub 凭据输入框」；
③ `SPEC-M4.md` §1.10-Q1：推入模式顺延 M5（本 SPEC 即其兑现）。
**需求方 2026-11-19 指令**：M5 推翻该红线，实现原生 Webhook 推入。

**拟议修订条文（随裁定一并入库，本 SPEC 不代改治理文件）**：

- `工程规则.md` §9 该条改为：
  「**GitHub 凭证仅允许两种受控形态**：① GitHub App 私钥（PEM，AES-256-GCM 密文落库，运行时换取
  短期 Installation Token）；② 显式豁免的 PAT（同一密文机制）。凭证**永不出现在任何 API 响应、
  日志、错误信息**中；契约层维持『只写不读』（写入形状存在，读取形状只有掩码/布尔位，
  归档于 `WRITE_ONLY_FIELDS`）。§9 其余条款（不入文档/提交信息、成本单一事实源、构建期不联网）
  **全部维持不变**。」
- `pages-and-flows.md` PG-09 边界句改为：
  「GitHub 凭证由平台**加密持有**（GitHub App / PAT，AES-256-GCM，见 SPEC-M5 §附录 C），本 Tab
  **不出现任何 GitHub 凭据明文与回显**（私钥无掩码形态、仅布尔位）。」

**裁定效果**：仅解除「持有 GitHub 凭证」禁令；「凭证不入文档/提交信息/日志」「只写不读」等纪律
**原样生效**且 M5 全程受其约束。

**裁定（2026-11-19，需求方）**：**批准**。按本节拟议条文执行两处修订；实际文件修订**随第一笔
`contracts(M5)` 入库，不提前提交**——红线解除的生效时点与契约落地绑定。

### Q1 · 鉴权方案：A（GitHub App，**推荐**）vs B（PAT 个人令牌）

| 维度 | **方案 A · GitHub App** | **方案 B · PAT（classic / fine-grained）** |
|---|---|---|
| 凭据形态 | App ID + Installation ID + RSA PEM 私钥（密文落库）；运行时 JWT（RS256，≤5 分钟）换取 **Installation Token（约 1h 自动过期）** | 长期 token 明文换取（密文落库后解密直用） |
| 权限最小化 | 按 App 权限集收敛：`pull_requests:read` + `commit_statuses:write`（Q5 评论再加 `pull_requests:write`） | 粒度靠创建者自律；classic PAT 一泄即全仓权限 |
| 失效半径 | 私钥泄露仍需 App ID + Installation ID 才可用；token 短期自愈 | token 即一切；泄露半径 = 账号全部授权范围 |
| 审计与归属 | 组织级安装，GitHub 侧有审计日志；与个人账号解耦 | 绑定个人账号：离职 / 改密 / token 轮换即断 |
| 速率限额 | Installation Token 限额独立且较高 | 共享账号限额 |
| 仓库接入 | 安装到组织/仓库即用；卸载事件可监听 | 逐仓配置 token |
| 实现复杂度 | 中：JWT 签名 + token 换取与缓存（复用 M2 密文机制后增量可控） | 低：存 token 即用 |
| 适用前提 | github.com 或已开启 Apps 的 GHES | 任意（含 GHES 关闭 Apps 场景） |

**本 SPEC 建议 A**；B 作为降级备选（仅当 GHES 未启用 Apps 等 App 不可用场景），两种形态的
落库列在 §2.2 同时草案（互斥 CHECK），按裁定只实现其一。**凭证落库与传输约束（两方案共通）**：
复用 M2 的 `db/provider-key-cipher.ts` **AES-256-GCM `v1:<iv>:<tag>:<ct>`** 机制（随机 IV、
`PROVIDER_KEY_SECRET` 现读、口令缺失即抛错不降级明文）；传输仅两个出口——GitHub JWT/Token 端点
与 REST API 调用；泄露控制详见 §附录 C。

**裁定（2026-11-19，需求方）**：**方案 A（GitHub App）**。理由：权限最小化
（`pull_requests:read` + `commit_statuses:write`）、Token 短周期自愈（1h 过期）、失效半径可控。
B（PAT）作为 GHES 降级备选：**落库列与互斥 CHECK 保留**，**M5 只实现 A**。

### Q2 · 支持面：M5 死磕 GitHub，还是同时做 GitLab / 飞书触发？

**建议：M5 只做 GitHub。** 飞书 / 企微已有 M4 出站通知（`GateChannel` 枚举），GitLab 无现状需求。
多平台抽象**只预留不实现**：`github_integrations.kind` 列（M5 仅 `'github_app'`，CHECK 锁死），
`GateChannel` 枚举**不动**（GitHub 回传走独立集成表，避免把「通知渠道」与「代码平台集成」两种
语义塞进一个枚举——若 Q5 裁定评论回传复用 `outbound_dispatch_logs`，其 `channel_kind` 增补
`'github'` 属 `contracts(M5)` 契约笔事项，单独评审）。

**裁定（2026-11-19，需求方）**：**只做 GitHub**。飞书 / 企微已有 M4 出站、GitLab 无现状需求；
`github_integrations.kind` CHECK 锁死 `'github_app'`；`GateChannel` 枚举不动；GitHub 回传走
独立集成表（不塞进 GateChannel 语义里）——分层正确，照此执行。

### Q3 · Synchronize（PR 更新）时是否中断上一次跑批（Cancel in Progress）？

**背景缺口（如实）**：现行 `eval_runs` 状态机只有终态冻结（`T-04`）与非法流转拒绝（`T-05`），
**没有「运行中取消」通道**——worker 无 cancel 检查点。

- **建议：中断（Cancel in Progress）**。不中断则同一 PR 连续 push 会把 worker 队列堆满陈旧 run，
  且旧 sha 的 Status 迟到落定会覆盖语义。
- **实现草案**：`eval_runs` 增 `cancel_requested boolean NOT NULL DEFAULT false`（0023 迁移）；
  synchronize 到达 → 旧 head_sha 的 run 置 `cancel_requested=true` → worker 在**每 Case 边界**
  检查并协作式终止（置 `CANCELLED`，受 `trg_eval_runs_guard` 约束需扩展合法流转
  `RUNNING → CANCELLED`）；GitHub 侧旧 sha 的 Status 按 Q5 口径落 `cancelled`（或 failure）。
- **简化备选（若裁定不中断）**：旧 run 跑完，但只回传最新 head_sha 的 Status；旧 sha 留旧状态。
  需在文档写明「陈旧结论仍在跑」的产品语义。

**裁定（2026-11-19，需求方）**：**中断（Cancel in Progress）**。不中断会把 worker 队列堆满
陈旧 run，且旧 sha 的迟到 Status 会覆盖语义。按 §1 实现草案执行：0023 迁移加
`cancel_requested boolean NOT NULL DEFAULT false`；扩展 `trg_eval_runs_guard` 允许
`RUNNING → CANCELLED`；worker 在每 Case 边界检查协作式终止。

### Q4 · 私有仓库的代码克隆凭证

**建议：平台永不克隆用户代码（架构基线使然）**——评测对象是 Target 的 HTTP 端点，不是仓库本身。
路径映射（若采用按文件路径 glob 触发，见 §2.3）通过 GitHub API **只读**列举变更文件：
方案 A 由 Installation Token 天然覆盖（App 权限 `pull_requests:read` 含 files）；方案 B 需 PAT 带
repo 读权限。**因此本 SPEC 不引入任何 git clone / 凭证配置面**；若未来出现「按代码内容评测」的
需求，另开 SPEC（Q4 已裁定：本版不含任何代码克隆路径）。

**裁定（2026-11-19，需求方）**：**永不克隆**。评测对象是 HTTP Target，不是代码；路径映射经
GitHub API 只读 files 列表实现，无需任何 clone 凭证。此边界写入 §3「明确不做」。

### Q5 · 回传形态：只打红/绿 Commit Status，还是详细 Markdown 评论？

**建议：两者都要，分两批落地**——
① **Commit Status**（`commit_statuses:write`）：`state ∈ success/failure/error/pending` +
`target_url` 指向平台 run 页 + `context='eval-platform/<评测集名>'`。这是门禁主信号（CI 拦截与
Branch Protection 消费它），Batch 3 必交付。
② **Markdown 评论**（`pull_requests:write`）：复用 Phase 2 实证的 `renderMarkdown` 纯函数
（指标表 / 逐规则明细 / 失败原因 / 无基线 fail-closed 提示），同一 Batch 或顺延半批。
若裁定只打 Status：评论顺延 M6，`pull_requests:write` 权限不申请（最小化）。

**裁定（2026-11-19，需求方）**：**两者都要，分两批**。Commit Status（`commit_statuses:write`）
Batch 3 必交付；Markdown 评论（`pull_requests:write`）顺延半批——放 Batch 3 尾部或并入 Batch 4。
权限清单按此收敛；`outbound_dispatch_logs.channel_kind` 增 `'github'` 属 `contracts(M5)`
契约笔事项。

### Q6 · 「门禁规则整体计算」约束——是否引入「按 PR 触发只评估特定规则子集」？

**背景（Phase 2 实测，硬约束）**：`evaluateRunGates` 对**数据集上全部启用规则**整体求值并落不可变
留痕——只要数据集上有任何启用的 BLOCK 规则未过，该集**所有** run 的拉取/回传结果都是 `FAIL`
（simulator 用例 A/B 已复现并留档 `572f36a`）。推入模式下 PR 触发的跑批落同一数据集，
会把「PR 冒烟规则」与「发布门禁规则」混在一起。

- **建议（备选先行）**：**M5 不改门禁求值内核**，用「按 PR 映射专用数据集」天然隔离——
  PR 触发绑定独立评测集（冒烟集），发布门禁留在主集；文档写明「同一数据集的规则全集对该集
  全部 run 生效」为产品行为。
- **改造备选**：规则增加「适用通道」字段（manual / pull_request / ci_pull 多选）——改
  `regression_gates` 表结构 + 求值语义 + `gate_evaluations` 留痕口径（milestones §5.3「门禁结果
  不可变」需重新表述），实现代价中等，且与「整体计算可申诉」的既有设计互斥。

**裁定（2026-11-19，需求方）**：**备选先行（不改求值内核）**。M5 **不改** `evaluateRunGates`
的整体计算语义；以「PR 触发绑定专用冒烟评测集」（独立数据集）天然隔离，与发布门禁主集分开；
文档写明「同一数据集的规则全集对该集全部 run 生效」是产品行为。「适用通道」字段方案留作未来
专项，不在 M5 范围。

---

## 2. 架构与数据模型（**草案**，裁定后以 `contracts(M5)` / 迁移笔入库）

### 2.1 推入模式全链路

```
GitHub ──POST /api/integrations/github/webhook──▶ 平台
          │ X-Hub-Signature-256 (HMAC-SHA256, secret=该集成 webhook_secret)
          │ X-GitHub-Delivery (GUID，幂等键)
          ▼
  校验签名（timingSafeEqual）→ delivery 落账（UNIQUE → 重放拒绝）→ 事件解析
  （pull_request: opened / synchronize / closed）→ PR→评测集映射（§2.3）
  ├─ opened/synchronize：绑定命中 → 旧 sha 取消（随 Q3）→ POST /api/runs
  │   （trigger_source='CI_WEBHOOK'——0009 枚举已有该值，ER-4 早就位）
  └─ closed：不触发跑批，delivery 留痕 SKIPPED_CLOSED
          ▼
  worker 跑批（既有执行层，零改动；Q3 裁定中断则加协作式取消检查点）
          ▼
  终态 → 复用 evaluateRunGates（gate_evaluations 不可变留痕）
          ▼
  出站回传（方案 A：JWT→Installation Token→REST；Status / 评论随 Q5）
  → 失败重试与留痕复用 0021 outbound_dispatch_logs（channel_kind 增 'github'，随 Q5）
```

### 2.2 新表 `github_integrations`（DDL 草案 → 0022，**未实现**）

```sql
CREATE TABLE github_integrations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  kind            text        NOT NULL DEFAULT 'github_app',
  app_id          text,                       -- 方案 A；方案 B 为 NULL
  installation_id text,                       -- 方案 A
  private_key_ct  text,                       -- 方案 A：PEM 密文（v1: AES-256-GCM，provider-key-cipher 同格式）
  pat_ciphertext  text,                       -- 方案 B：PAT 密文（与 A 互斥）
  webhook_secret  text        NOT NULL,       -- HMAC 校验密钥；**永不出 API**（读写面见 §附录 C）
  repos           jsonb       NOT NULL DEFAULT '[]',   -- [{owner, repo}]
  is_active       boolean     NOT NULL DEFAULT true,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_github_integrations_kind CHECK (kind IN ('github_app')),
  -- 凭据形态互斥：App 与 PAT 二选一（随 Q1 裁定可收紧为单形态）
  CONSTRAINT ck_github_integrations_cred CHECK (
    (private_key_ct IS NOT NULL AND pat_ciphertext IS NULL)
    OR (private_key_ct IS NULL AND pat_ciphertext IS NOT NULL)
  )
);
```

配套 `webhook_deliveries`（重放拒绝的物理载体，**整表不可变**）：

```sql
CREATE TABLE webhook_deliveries (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id       text        NOT NULL,   -- X-GitHub-Delivery GUID
  integration_id    uuid        NOT NULL REFERENCES github_integrations (id) ON DELETE CASCADE,
  event             text        NOT NULL,   -- 'pull_request' 等
  signature_verified boolean    NOT NULL,
  processed_status  text        NOT NULL,   -- TRIGGERED / SKIPPED_CLOSED / SKIPPED_UNBOUND / DEDUPED / REJECTED_SIGNATURE
  run_id            uuid        REFERENCES eval_runs (id) ON DELETE SET NULL,
  payload_summary   jsonb       NOT NULL,   -- 白名单摘要（repo/pr 号/sha/action），不落全量载荷
  received_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_webhook_deliveries_delivery UNIQUE (delivery_id)
);
CREATE INDEX ix_webhook_deliveries_integration ON webhook_deliveries (integration_id, received_at DESC);
```

注册表影响预估：`TABLE_NAMES` 18 → **20**；`FULLY_IMMUTABLE_TABLES` +1（webhook_deliveries）；触发器
21 → **22**（组合触发器，0020/0021 范式）；`T-10` 硬编码 21 → 22。**迁移设计时精算，随 `contracts(M5)` 笔**。
`github_integrations` 为可编辑配置表（不进完全不可变循环）；其凭据三列（private_key_ct /
pat_ciphertext / webhook_secret）**读取侧永不出口**（§附录 C）。

### 2.3 PR → 评测集映射（三策略 + 优先级）

独立映射表 `pr_trigger_rules`（草案，与 §2.2 同迁移批）：

```sql
CREATE TABLE pr_trigger_rules (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid    NOT NULL REFERENCES github_integrations (id) ON DELETE CASCADE,
  repo_full_name  text    NOT NULL,              -- 'owner/repo'
  target_branch   text,                          -- 策略①：目标分支（精确或前缀通配）
  path_globs      jsonb,                         -- 策略②：变更文件路径 glob 数组（经 GitHub API files 列表匹配）
  label           text,                          -- 策略③：PR Label 精确匹配
  dataset_id      uuid    NOT NULL REFERENCES datasets (id) ON DELETE RESTRICT,
  target_id       uuid    REFERENCES targets (id) ON DELETE RESTRICT,  -- 可空 = 不限目标
  enabled         boolean NOT NULL DEFAULT true,
  created_by      text    NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**匹配优先级**：label > path_globs > target_branch；多条规则命中 → **各自触发一个 run**（每评测集
一个，互不串扰）；零命中 → `SKIPPED_UNBOUND` 留痕不建 run。**Q6 已裁定备选先行**：本表绑定的
是「PR 专用评测集」（冒烟集），与发布门禁主集天然隔离——不改门禁求值内核。

### 2.4 契约扩展草案（zod / openapi 摘要——**裁定后 `contracts(M5)` 笔入库**）

- **入站**（平台新路由，唯一一个）：`POST /api/integrations/github/webhook`——
  头部 `X-Hub-Signature-256` / `X-GitHub-Event` / `X-GitHub-Delivery`；载荷**白名单 parse**
  （`PullRequestEvent = { action: 'opened'|'synchronize'|'closed', number, pull_request: { head: {sha, ref}, base: {ref}, labels[], html_url } }`），
  全量载荷**不落库**（只落 §2.2 的 summary）；签名校验失败 → 401 且不落 deliveries。
- **出站**（调用 GitHub API，非本平台路由，以 TS 类型声明）：`CommitStatusInput{state, target_url, description, context}`、
  `PRCommentInput{body}`；权限清单随 Q1/Q5（`pull_requests:read` + `commit_statuses:write` + 可选 `pull_requests:write`）。
- **配置面**：`GithubIntegrationCreate{ name, appId?, privateKey?(只写), webhookSecret?(只写), pat?(只写), repos }`；
  读取形状 `GithubIntegration` **只有** `hasPrivateKey / hasWebhookSecret / hasPat` 布尔位 + `appId` 回显，
  归档进 `contracts/src/api.ts` 的 `WRITE_ONLY_FIELDS`（承 §9「契约层只写不读」）。
- openapi 增量：入站 webhook 路径 + 集成 CRUD 路径 + `GithubIntegration*` 组件（**草案正文见本文件 §2.4，不预先入库**）。

### 2.5 安全模型推演（威胁 → 控制）

| # | 威胁 | 控制 | 验收锚点 |
|---|---|---|---|
| T-1 | DB 泄露带走 GitHub 凭证 | AES-256-GCM 密文（复用 `v1:` 机制与 `PROVIDER_KEY_SECRET` 现读纪律）；解密点仅两处（token 换取 / 回传调用） | §4-4 |
| T-2 | API 响应泄漏私钥/PAT/secret | 契约非对称（只写不读 + 布尔位）；`provider-secret-leak.spec` 范式新增泄密扫描 | §4-4 |
| T-3 | 伪造 webhook（攻击者无 secret） | HMAC-SHA256 + `timingSafeEqual` 常量时间比较；失败 → 401 且**不落** deliveries | §4-1 |
| T-4 | 重放（截获合法请求原样重发） | `X-GitHub-Delivery` UNIQUE 落账；重复 → 200 `{deduped:true}` 不再触发 | §4-2 |
| T-5 | 越权触发他集评测 | secret 校验只证明「来自该集成」；repo→dataset 映射显式绑定，未绑定 → `SKIPPED_UNBOUND` | §4-6 |
| T-6 | 日志泄漏凭据 | 私钥/PAT/签名头永不进日志（§9 既有纪律，随 Q0 修订维持） | 泄密扫描 |
| T-7 | 陈旧结论覆盖 | synchronize 取消语义（随 Q3）；Status 绑定 sha 不可互相覆盖 | §4-3 |
| T-8 | GitHub 端权限过大 | 方案 A 权限最小化 + Installation Token 1h 过期（Q1 推荐主因） | 复核会话 |

### 2.6 触发与取消（Q3 已裁定中断）

见 §1-Q3 实现草案（0023 `cancel_requested` + guard 扩展 + worker Case 边界协作式检查）。
**明确不做**：不实现「删除既有 Status」（GitHub 无此 API）；不实现跨仓库评测结果聚合；
**不实现任何形式的用户代码克隆**（Q4 已裁定：评测对象是 HTTP Target，路径映射走 GitHub API
只读 files 列表）。

---

## 3. 批次与原子任务（草案，裁定后按 SPEC 精化再排 Batch 1）

> 全部批次的准出照 M4 惯例：`npm run typecheck && npm run lint:design && npm test` 全绿
> （0 failed / **0 skipped**）+ 研发自检 §6 如实填写 + 契约扩展单独成笔。

| Batch | 类型 | 原子任务 | 准出要点 |
|---|---|---|---|
| Batch 1 | [BE] 契约笔 | `contracts(M5):` 0022/0023 迁移（github_integrations / webhook_deliveries / pr_trigger_rules / cancel_requested——Q3 已裁定）+ 注册表与事实文档 + **随笔入库：§9 与 PG-09 修订（Q0）** + zod（webhook 白名单、集成配置掩码形状、出站声明）+ openapi（webhook 入站 + 集成 CRUD） | 双镜像 cmp；T-10 精算；泄密扫描用例先红后绿 |
| Batch 2 | [BE] | HMAC 校验（timingSafeEqual）→ delivery 幂等 → 事件白名单解析 → PR 映射 → 建 run（`trigger_source='CI_WEBHOOK'`）+ 取消通道（Q3 已裁定中断） | §4-1/2/5/6/7 全绿；本地假 GitHub 服务器范式（callback-token.spec 同款） |
| Batch 3 | [BE] | 终态回传出站：Installation Token 换取与缓存 + Commit Status 写入（**必交付**）；Markdown 评论**顺延半批**（Batch 3 尾或并入 Batch 4，Q5）；失败落 0021 留痕（channel_kind 增 'github'，contracts(M5) 笔） | Status payload 断言；token 缓存命中断言；401/422 处理 |
| Batch 4 | [FE] | PG-09 新「GitHub 集成」Tab：集成 CRUD（凭据只写不读）、仓库绑定、触发规则映射表、delivery 历史；role 语义照 2026-11-18 裁定（A 只读 / B 可操作） | 掩码/布尔位断言；静态 + 浏览器档（settings-tabs.spec 范式） |
| Batch 5 | [INT] | 真实仓库 PR 全链路联调（test 仓库发 PR → Status 落地）+ 安全审计（密钥扫描、`WRITE_ONLY_FIELDS` 对照）+ 独立复核（全新上下文会话） | 复核 ACCEPT → `v0.2.0-m5`（打 tag 需授权） |

**明确不做（M5）**：GitLab / 其他平台触发（Q2 已裁定只做 GitHub）；**用户代码克隆与内容评测**
（Q4 已裁定：永不克隆）；跨仓库结果聚合；删除既有 Status；Badcase 回流（US-012 永不做）；
多租户；门禁求值语义改造（Q6 已裁定备选先行，「适用通道」留未来专项）。

---

## 4. 验收条件（Given / When / Then——**Batch 5 独立复核的判定标准**）

1. **伪造签名被拒**：Given 集成已配置 `webhook_secret`；When 收到 `pull_request` 事件但其
   `X-Hub-Signature-256` 为攻击者自行计算值；Then 响应 401，`webhook_deliveries` **无**该
   delivery 行，未创建任何 EvalRun。
2. **重放被拒（幂等）**：Given 同一合法 `opened` 事件已被处理（`X-GitHub-Delivery` 已落账且
   触发过 run）；When 原样重放（同 signature 同 delivery_id）；Then 响应 200 且含 `deduped:true`，
   **不新建**第二个 run，原 run 状态不受影响。
3. **Synchronize 取消旧跑批**（Q3 已裁定中断）：Given PR #7 在 head_sha₁ 的 run 处于 `RUNNING`；
   When 收到同 PR head_sha₂ 的 `synchronize` 事件；Then sha₁ run 协作式置 `CANCELLED`、sha₂ 新
   run 建立，且 sha₁ 的 Commit Status 终值按 Q5 口径落定（不出现 sha₂ 结论写在 sha₁ 上的错位）。
4. **私钥不以明文出现在任何 API 响应**：Given 集成已保存 PEM 与 webhook_secret；When 请求
   `GET /api/integrations/github` 列表 / 详情以及**任何**错误响应；Then 响应体不含 PEM 的任何
   片段（含 `-----BEGIN` 头行）、不含 `webhook_secret` 明文，仅有 `hasPrivateKey:true` /
   `hasWebhookSecret:true` 布尔位；泄密扫描用例（`provider-secret-leak.spec` 范式）全绿。
5. **closed 事件不触发评测**：When `pull_request.closed` 事件通过签名校验到达；Then 不创建
   EvalRun，delivery 留痕 `processed_status='SKIPPED_CLOSED'`。
6. **未绑定仓库不触发**：When 事件的 `repo_full_name` 不在 `pr_trigger_rules`；Then 响应 202，
   delivery 留痕 `SKIPPED_UNBOUND`，不建 run。
7. **映射多命中互不串扰**：When 一个 PR 事件同时命中两条启用规则（不同评测集）；Then 各建一个
   run（`trigger_source='CI_WEBHOOK'`），各自的回传互不影响，`gate_evaluations` 按各自数据集
   规则全集求值（Q6 口径）。

---

## 5. 与事实源的冲突与差异（须记录，不得静默）

| 项 | 原文 / 现状 | M5 变更 | 状态 |
|---|---|---|---|
| `工程规则.md` §9 | 「不在项目中配置 GitHub PAT」 | 推翻为「受控持有（App/PAT 密文）」，其余条款不变；修订条文见 §1-Q0 | 🟡 **已批准（Q0，2026-11-19）**——随第一笔 `contracts(M5)` 入库 |
| `pages-and-flows.md` PG-09 边界句 | 「永不持有、永不输入任何 GitHub PAT；本 Tab 不出现任何 GitHub 凭据输入框」 | 改为「凭据由平台加密持有；本 Tab 不出现凭据明文与回显」 | 🟡 同上（Q0 批准，随 `contracts(M5)` 入库） |
| `SPEC-M4.md` §1.10-Q1 | 推入模式顺延 M5 | 本 SPEC 即其兑现 | ✅ 兑现 |
| `milestones.md` | 止于 M4；`US-018` GitHub 部分顺延 | 需增补 M5 行 + `US-022`（webhook 集成）/ `US-023`（结果回传）提案，故事归属待拍 | ⬜ 待执行（随 `contracts(M5)` 或 Batch 1 入库） |
| `GateChannel` 枚举 | feishu / wecom / webhook | **不动**（GitHub 回传走独立集成）；`outbound_dispatch_logs.channel_kind` 增 `'github'` 属 `contracts(M5)` 事项 | ⬜ contracts(M5) 笔 |
| 「门禁规则整体计算」 | 实测产品行为（simulator 留档） | Q6 已裁定备选先行：专用数据集隔离，不改求值内核；文档写明整体计算为产品行为 | ✅ 已裁定（2026-11-19） |

---

## 6. 研发自检记录（Batch 完成后填写，当前为空模板）

> 本节由研发侧在 M5 最后一个 commit 前填写，对应各 Batch 准出条件。
> **「已通过」只对实跑过的检查项成立**；未跑的项目必须显式列为「未验证」。

### 6.1 提交信息（待填）

### 6.2 批次完成情况（待填）

### 6.3 机械门禁实测（待填：每条读数必须写明环境条件；`npm test` 必须写 N passed / M skipped）

### 6.4 未验证范围（如实列出，不写「应该没问题」）

（初始沿承：U-1 关闭前的 `taskkill` 分支、M2 三项补验、`e2e-fail.ts` 原样运行——处置随
各自清单更新；M5 自身的新增未验证项随 Batch 5 联调结果回填。）

---

## 附录 A · 裁定回填汇总表（v0.2 · 2026-11-19 需求方七项裁定）

| # | 议题 | 裁定 | 日期 |
|---|---|---|---|
| Q0 | 红线推翻（§9 + PG-09 修订入库） | **批准**——按 §1-Q0 拟议条文执行；两处事实/治理文件修订**随第一笔 `contracts(M5)` 入库，不提前提交** | 2026-11-19 |
| Q1 | 鉴权方案（A App / B PAT） | **方案 A（GitHub App）**——权限最小化、Token 1h 自愈、失效半径可控；B 作 GHES 降级备选（互斥 CHECK 保留），M5 只实现 A | 2026-11-19 |
| Q2 | 支持面（只做 GitHub？） | **只做 GitHub**——`kind` CHECK 锁 `'github_app'`；`GateChannel` 枚举不动；回传走独立集成表 | 2026-11-19 |
| Q3 | Synchronize 中断（Cancel in Progress） | **中断**——0023 `cancel_requested` + `trg_eval_runs_guard` 扩展 `RUNNING→CANCELLED` + worker 每 Case 边界协作式终止 | 2026-11-19 |
| Q4 | 私有仓库克隆凭证（建议：永不克隆） | **永不克隆**——评测对象是 HTTP Target；路径映射走 GitHub API 只读 files；写入 §3「明确不做」 | 2026-11-19 |
| Q5 | 回传形态（Status / Status+评论） | **两者都要分两批**——Commit Status Batch 3 必交付；Markdown 评论顺延半批（Batch 3 尾或 Batch 4）；权限清单收敛；channel_kind 增 `'github'` 属 contracts(M5) 笔 | 2026-11-19 |
| Q6 | 门禁规则子集（备选先行 vs 改求值语义） | **备选先行**——不改 `evaluateRunGates` 整体计算语义；PR 触发绑定专用冒烟评测集；「同一数据集规则全集对该集全部 run 生效」为产品行为；「适用通道」留未来专项 | 2026-11-19 |
