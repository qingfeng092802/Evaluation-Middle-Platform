# HANDOFF · 评测中台接手交接包（v2 · M4 Batch 2-4 收尾时点）

> **本文件的唯一用途**：让接手的 AI 工具（ZCode / Claude Code / Codex / Cursor）在不读聊天记录的前提下，
> 靠**可寻址的路径与可复验的命令**恢复上下文。
>
> **不写散文，只写事实。** 每个数字都能用同节给出的命令复验；复验不出来即为本文件错误。
>
> 生成时间：2026-11-18 · 生成者：ZCode（M4 Batch 2-4 收尾会话；v1 为 M2 收尾版，`git show 3e9f556:docs/HANDOFF.md` 可考古）
> **约束**：本文件不修改任何已合并的 commit 或 tag，也不代表对未启动范围拍板。
>
> **补记（2026-11-18，M3 复核会话）**：M3 的**第二次独立复核已完成并 ACCEPT**，正式留档
> `docs/Spec/M3-复核记录.md`（复核树 = merge `2dec565` 同 tree）。`SPEC-M4.md` §0 检查
> 1/4/5 已回改 ✅；检查 2（M2 补验，缺真实厂商 Key）/ 检查 3（U-1，待 CI / 另一台 Windows）
> 维持 ⬜，原因与解除条件见该记录 §7。复核过程与本会话曾发生测试进程 / 端口争用（复核侧
> 终止过本会话的测试进程树，处置全程留痕于该记录 §4）；其隔离方案与本文件 §4.4 的
> globalSetup「复用不杀」语义兼容，两栈曾共存取证。

---

## 1. 任务与状态

| 项 | 值 |
|---|---|
| 项目 | 企业级 AI 评测中台（Evaluation Middle Platform） |
| 项目根目录（AI 约定入口所在） | `D:\Evaluation Middle Platform`（`AGENTS.md` / `docs/` 在此，**root 不是 git 仓库**） |
| **源码根目录（git root）** | **`D:\Evaluation Middle Platform\src`** —— 独立 Git 仓库 |
| remote origin | `https://github.com/qingfeng092802/Evaluation-Middle-Platform.git` |
| M1 | ✅ `dc04385` / tag `v0.1.0-m1`（已推）—— 确定性评测闭环 |
| M2 | ✅ `5277fd5` / tag `v0.1.0-m2`（已推）—— 多模型网关 / Judge / SSE 并发 |
| M3 | ✅ **merge `2dec565` / tag `v0.1.0-m3`（2026-11-18 已推）** —— AB 对比与 Badcase Diff |
| **M4** | **Batch 2 / 3 / 4 已完成并推送（分支 `feat/m4-gates`，tip `eb56dc0`）；Batch 1 推迟；Batch 5 未启动** |
| 当前分支 | `feat/m4-gates`（HEAD = `eb56dc0`） |
| `main` HEAD | `2dec565`（= origin/main） |
| 工作区状态 | 干净（`git status --porcelain` 为空） |
| 全量门禁读数 | **833 passed / 0 skipped / 0 failed（70 文件，298s）**；`typecheck` + `lint:design` 绿 |

里程碑合并方式均为 `--no-ff` merge commit + annotated tag（复验 `git cat-file -t v0.1.0-m3` = `tag`）。
M3 合入 main 时，需求方指令链：M3 复核曾 REJECT（waitForTimeout 未清理 + §6 自检记录未写）→
修补会话两笔补齐（`27f83d1` / `25cd0ce`）→ 需求方 2026-11-18 指令按流程合并打 tag。

### 1.1 M4 提交链（分支 `feat/m4-gates`，可逐条 `git show` 校验）

```
25cd0ce  docs(M3): 补齐研发自检记录与三连跑留档                      ← M3 终点（已在 main；tag v0.1.0-m3 指向 merge 2dec565）
a6f1dfe  feat(M4): Batch 2 gates CRUD 与判定引擎（US-017 数据面）
f39b855  contracts(M4): CI 回调 Token 契约与 0020 迁移（拉取鉴权，Q1=C）
cf6fc58  feat(M4): Batch 2 gates CRUD 与判定引擎（US-017 数据面）   ← 同名两笔：先笔被钩子拦下后的重发笔
51c7367  contracts(M4): 补 UNAUTHORIZED 错误码（Batch 3 拉取鉴权 401，Q1=C）
3bdc828  feat(M4): Batch 3 回调 Token 生命周期 + 拉取鉴权 + 出站派发（US-018，Q1=C）
21c7fed  contracts(M4): 台账 time 维 + unknownCostCases + T2 开关翻 true（Batch 4 三项契约扩展）
8c18075  feat(M4): Batch 4 成本台账聚合 + PG-10 大盘 + PG-09 渠道 Tab + PG-07 算子库 + US-021 T2
3f53cf3  test(M4): globalSetup 自举 dev server——浏览器对账测试不再静默 skipped
eb56dc0  feat(M4): Batch 4 补齐——门禁固定历史基线求值（gate.baselineId）   ← 分支 tip
```

分支拓扑：`feat/m3-baseline-chain` 已**回卷**到 `25cd0ce`（纯 M3，完全包含于 main；
远端 tip 仍停在 `82f7088`，本地为快进后代，推送无需 force）；`feat/m4-gates` 的 merge-base
与 main = `25cd0ce`（复验：`git merge-base main feat/m4-gates`）。同名重复分支
`feat/m4-gates-ci`（同 tip）已清理。

复验命令：

```bash
cd "D:/Evaluation Middle Platform/src"
git log --oneline -1 origin/main                 # 2dec565 merge(M3): …
git log --oneline -1 origin/feat/m4-gates        # eb56dc0 feat(M4): Batch 4 补齐…
git ls-remote --tags origin | grep m3            # refs/tags/v0.1.0-m3
git status --porcelain                           # 空
npm run typecheck && npm run lint:design         # 双绿
npm test                                         # 833 passed / 0 skipped（globalSetup 会自举 :3000，见 §4.4）
```

---

## 2. 四个里程碑完成面（每条可由路径复验）

### 2.1 M1 · 确定性评测闭环（v0.1.0-m1）

- 数据底座：`db/migrations/0001…0020`（17 表；0019 幂等账本 + fencing、0020 回调 Token）；
  `docs/facts/database-schema.md` 是列事实源；`contracts/src/db-schema.ts` 是可编译索引
  （`TABLE_NAMES` / `TRIGGER_NAMES` / `EXPECTED_TRIGGER_COUNT`，迁移测试 `T-10` 断言 20 个触发器）
- 算子：六内置（`contracts/src/evaluator.ts` `BuiltinEvaluatorKey`），各有 golden test
- 页面：`PG-01…PG-06`（数据集导入 / 发起评测 / 运行详情 / 目标配置）

### 2.2 M2 · 网关 / Judge / SSE 并发（v0.1.0-m2）

- `lib/gateway/`（多模型路由 + probe）、`lib/operators/judge.ts`（裁判注入）、`worker/`
  （claim/heartbeat/fencing/并发闸门/僵尸回收）
- 幂等账本 `gateway_idempotency`（0019）+ `claim_epoch` fencing
- 成本：`eval_case_results.cost_target/judge/total`（生成列），`model_prices` 分时取价（调价只增行）

### 2.3 M3 · AB 对比 / Badcase Diff / 基线制度（v0.1.0-m3）

- 基线提名/确认（`US-013`/`US-020`，ROLE-A/B，`X-Role` 约定）：`app/api/baselines/*`、`db/repo/baselines.ts`
- 对比：`GET /api/compare`、`GET /api/compare/diff`（`describeIncomparable` 硬拒绝）；`PG-08` / `PG-04` 双栏
- 留档：`docs/Spec/SPEC-M3.md` §6（研发自检记录与三连跑读数）

### 2.4 M4 · 门禁 / Token / 台账 / T2 / 算子库（`feat/m4-gates`，待复核合入 main）

| 交付物 | 路径 | 测试 |
|---|---|---|
| 门禁规则 CRUD（`US-017`） | `app/api/gates/route.ts`、`app/api/gates/[gateId]/route.ts` | `tests/gates.spec.ts`（11） |
| 判定引擎 + 结果拉取（Q1=C 拉取模式） | `lib/api/services/gates.ts`（`evaluateRunGates`）、`app/api/gates/results/[runId]/route.ts` | 同上 + `tests/gates-pinned-baseline.spec.ts`（4） |
| 回调 Token（明文仅一次，只存 SHA-256） | `app/api/gates/[gateId]/callback-token/route.ts`、0020 迁移 `trg_callback_tokens_immutable` | `tests/callback-token.spec.ts`（9） |
| 拉取鉴权 fail-closed | results 路由先 `verifyCallbackTokenForRun`：缺失/无效 401、跨集 401、合法 Token+未知 run 404 | 同上 |
| 出站派发（飞书/企微/webhook） | `dispatchGateResult`：求值时对**本轮新判定**的规则推送，失败只告警不阻塞 | 同上（本地真实 HTTP 捕获，非 mock） |
| 固定历史基线求值（`gate.baselineId`） | 逐规则锚点：无 pin 锚已确认基线（BL-2），有 pin 锚该 baselines 行；REJECTED/跨集/锚缺失 ⇒ 跳过不判定；跨集 pin 写入侧 400 | `tests/gates-pinned-baseline.spec.ts` |
| 成本台账四维（`US-019`，Q5） | `app/api/ledger/route.ts`、`db/repo/ledger.ts`（SQL GROUPING SETS，numeric 聚合不出 node——TS-2 红线）；fixture 行按种子名排除（milestones §5.3） | `tests/ledger.spec.ts`（6） |
| `PG-10` 台账大盘 | `app/ledger/page.tsx`（四维切换 + 汇总卡 + 图表/表格孪生 + `unknownCostCases` 强制露出）；ECharts 主题走 `lib/charts/theme.ts` Token（测试断言无裸 hex） | `tests/m4-ui.spec.ts`（12） |
| `PG-09` 推送渠道 Tab（`US-018` 呈现层） | `app/settings/channels-section.tsx`（Token 明文仅一次展示状态机） | 同上 |
| `PG-07` 算子库（`US-016`） | `app/api/evaluators/*` + `app/evaluators/page.tsx`；内置六算子运行时合成（不入库，PATCH 404）；模板改版 version+1，PT-1 由 `run_evaluators` 快照不可变兑现 | `tests/evaluators.spec.ts`（4） |
| `US-021` T2 外部 HTTP Target | `TARGET_T2_ENABLED=true`（契约单点开关）；authHeader 密文入库（`encryptProviderKey`，修复骨架期明文直存）、PATCH 省略继承上一版本、执行期回读**不可变**版本行解密；`config_snapshot` 绝不收密文；无 usage ⇒ tokens 0 + 台账 unknown 计数（US-021：不估算） | `tests/target-t2.spec.ts`（7） |

契约扩展三笔均单独成笔（`f39b855` / `51c7367` / `21c7fed`），Zod 与 `openapi.yaml` 两处事实源同步。

---

## 3. 关键文件路径

- 协作入口：`D:\Evaluation Middle Platform\AGENTS.md`（纪律）→ `docs/工程规则.md` → `LEARNINGS.md`（教训台账）
- 事实源：`docs/facts/`（database-schema / technical-solution / pages-and-flows / user-stories / product-overview）
- 规格：`docs/Spec/SPEC-M1..M4.md`、`docs/Spec/milestones.md`（里程碑总览与 US 覆盖矩阵 §6）
- 契约：`src/contracts/src/*.ts`（形状唯一事实源）+ `contracts/openapi.yaml`（两处必须同步改）
- 门禁：`.githooks/`（root 仓管 specs 文档防篡改；`src/.githooks/` 管代码仓——pre-commit = typecheck + lint + 全量测试）
- 本文件镜像：`src/docs/HANDOFF.md`（git 内正本）与 `D:\Evaluation Middle Platform\docs\HANDOFF.md`（root 镜像，人工同步）

---

## 4. 已知边界与教训（接手必读）

### 4.1 U-1 · `taskkill` 子孙清理分支

口径不变（v1 §4.1）：CI Windows 环境下 H-11 用例（断言 `taskkill /T /F` 分支真实执行）**仍未跑过**，
属 Batch 1 遗留。M3 复核已通过（v0.1.0-m3 已合并），Batch 1 的准入闸门**现已打开**。

### 4.2 M2 未验证项补验（Batch 1 另一半）

LiteLLM 真容器（`docker compose --profile gateway up`）跑一次真实 LLM-as-a-Judge；真实厂商网关连通；
浏览器 `EventSource`——三项补验清单见 `docs/Spec/SPEC-M4.md` §0 表第 2 行。

### 4.3 并发钩子互踩测试库（本会话实测教训）

两次 `git commit` 的 pre-commit 全量测试**并发**运行会互踩同一个 `eval_platform_test`
（dropAndRecreateSchema 竞态 ⇒ 实测 95 failed）。纪律：提交必须**串行**，等上一条钩子跑完再提下一笔；
另 `| tail` 管道会吞 commit 的真实 rc（两次踩坑），必须 `echo RC=$?` 或输出落文件复验。

### 4.4 globalSetup 三态语义（`tests/global-setup.ts`）

`npm test` 探测 `:3000`：外部已有 dev:all ⇒ 复用且 teardown **不杀**（不是本进程拉起的不归本进程处置）；
未起 ⇒ detached 拉起 `npm run dev:all` + 150s 就绪轮询，teardown `taskkill /T /F` 整树；
拉起失败 ⇒ **全量直接失败**（不回退成 skipped）。数据前提：dev 库 `eval_platform` 需有评测集与
≥2 条 Case 的 run（seed 与历史真栈自检数据已满足）。Windows 注意：`.cmd` shim 无 shell spawn
直接 EINVAL（CVE-2024-27980），须 `shell: true`。

### 4.5 其它会话的工作树

`D:\Evaluation Middle Platform\wt-m3-review`（git worktree，M3 复核会话遗留）内可能有 dev-all
常驻进程（node + next dev -p 3000）。**不要杀**——不是本仓工作树；确认无用时由需求方处置。
甄别命令：`powershell "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\""` 按命令行路径区分
`wt-m3-review` 与 `src`。

### 4.6 自动化

定时自动化 `automation-6e85e0b3`（每小时检测 M3 修补 + 推进 M4）**已 CronPauseSelf 暂停**——
Batch 5 需要需求方侧资源（runner / 真实 Key / 独立复核会话），自动触发无法推进；需要时手动恢复。

---

## 5. 剩余与下一步（建议顺序）

| # | 事项 | 归属 | 前置 / 依赖 |
|---|---|---|---|
| 1 | **M4 复核合入 main + 打里程碑 tag** | 独立复核会话（建议全新上下文）→ 需求方授权 | 复核材料 = 本文件 §2.4 表 + `SPEC-M4` §2 各批准出条件；范围 `feat/m4-gates` 十笔提交（`a6f1dfe…eb56dc0`） |
| 2 | **Batch 1**：U-1 CI Windows 验证 + M2 三项补验（LiteLLM 真容器 / 真实厂商连通 / 浏览器 EventSource） | `SPEC-M4` §0 表 | M3 复核已过、闸门已开；U-1 需 CI 或另一台 Windows 机器 |
| 3 | **`INT-M4-13` 真实 CI 联调**：测试仓库发 PR → 触发跑批 → CI 持 Token 拉 `GET /api/gates/results/{runId}` → 红/绿信号落 PR | `SPEC-M4` §2 Batch 5 | 自托管 runner + 测试仓库 + 真实厂商 Key（本地 `.env` 不入库——Q8 裁定） |
| 4 | **`INT-M4-14` 安全加固收尾**：getsentry/skills 审计、依赖与密钥扫描、`.gitignore` 复核 | 同上 | 可与 3 并行 |
| 5 | **`PG-09` 门禁规则 Tab（`US-017` 呈现层）**：API 全齐（CRUD/Token/求值/baselineId），settings 页 `PENDING_TABS` 仍是占位 | M4 呈现层收尾 | 纯前端 + `lib/ui` 派生层单测（参照 `channels-section` 模式） |
| 6 | `PG-09` 基线确认 Tab：`/api/baselines/{id}/decision` API 已有，Tab 未建 | 同上 | 同上 |
| 7 | `PG-10` 下钻 `PG-03`：台账行 → 运行台过滤链接（当前为静态行无下钻） | `SPEC-M4` `[FE-M4-09]` 细化 | 纯前端 |
| 8 | 出站派发的重试/失败留痕口径：当前失败仅 `console.warn` | `SPEC-M4` Batch 3 准出条件（「失败留痕口径待 Q1 裁定后细化」） | **待需求方裁定**留痕表形态 |
| 9 | **M5+ 顺延项**（Q1 裁定整体顺延）：推入模式（Webhook 入站 + 签名校验 + PR 评论/Commit Status 回传——需推翻 `工程规则.md` §9 的平台不持 PAT 红线，须显式裁定）、GitHub App 全量集成、多平台 Webhook | `SPEC-M4` §3 | M4 复核通过后另立 SPEC-M5 |

---

## 6. 复验命令汇总

```bash
cd "D:/Evaluation Middle Platform/src"
git log --oneline -1 origin/main origin/feat/m4-gates   # 2dec565 / eb56dc0
git status --porcelain                                  # 空
npm run typecheck && npm run lint:design                # 双绿
npm test                                                # 833 passed / 0 skipped / 0 failed（~300s）
git tag -l                                              # v0.1.0-m1 / v0.1.0-m2 / v0.1.0-m3
git ls-remote --heads origin                            # main / feat/m3-baseline-chain / feat/m4-gates
curl -s http://127.0.0.1:3000/api/runs?limit=1          # globalSetup 自举后或手动 dev:all 时 200
```

> 本文件替代 v1（M2 收尾版）。M1/M2/M3 的提交链与复验细节以各里程碑 SPEC 与 tag 为准，此处不再重复。
