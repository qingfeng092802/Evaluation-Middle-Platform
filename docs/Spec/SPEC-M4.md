# SPEC-M4 · CI/CD 回归门禁、安全加固与全局成本对账台账（MVP 收官）

> **状态**：**v0.2 —— 九项裁定（Q0–Q8）已于 2026-11-16 全部回填**（见 §1 各条「裁定」行
> 与 §1.10 汇总表）；**Q0：M3 复核 REJECT，Batch 1（遗留补验）推迟至 M3 修补完成并复核
> 通过**；Q1 采用 **C 拉取模式**（事实源现状维持，推入模式顺延 M5）。Batch 2–4 按
> 需求方 2026-11-16 指令并行推进。
> **上位事实源**：`docs/Spec/milestones.md` §5（M4 范围 / 关键约束 / 完成判定）、
> `docs/HANDOFF.md` §5.6（M4 准入义务：M2 未验证项已补验）、`docs/facts/user-stories.md`
> （`US-016` `US-017` `US-018` `US-019` `US-021`）、`docs/facts/pages-and-flows.md`
> （`PG-07` `PG-09` `PG-10`）、`docs/工程规则.md` §9（平台永不持有 GitHub PAT）、
> `src/contracts/`（gate.ts / api.ts 已锁形状）。
> **冲突时以事实文档为准**；本文件与用户口头预期的差异**不静默吞掉**，全部进 §5
> 与原始编排的差异表 + §1 待确认清单。
>
> 阅读顺序（`AGENTS.md` §一）：`AGENTS.md` → `docs/工程规则.md` → `docs/facts/` →
> `src/contracts/` → 本文件。

---

## 0. 全局前置检查（Batch 1 开始前逐条确认）

| # | 检查项 | 判定方法 | 状态 |
|---|---|---|---|
| 1 | **M3 已合并入 `main` 并打 `v0.1.0-m3`** | `git fetch origin --tags && git log --oneline origin/main -1` 应包含 M3 提交链；`git tag -l` 应含 `v0.1.0-m3` | 🔴 **待核实（2026-11-17 实测不符）**：origin/main = `1a4c00e`（不含 M3），tag 仅 `v0.1.0-m1`/`v0.1.0-m2`，M3 分支 `feat/m3-baseline-chain`（tip `82f7088`）**未合并**。见 §1.9-Q0 |
| 2 | **M2 未验证项补验**（HANDOFF §5.6 准入义务） | LiteLLM 真容器（`docker compose --profile gateway up`）跑一次真实 LLM-as-a-Judge；真实厂商网关连通；浏览器 `EventSource` | ⬜ 待执行（Batch 1 准入闸门） |
| 3 | **U-1 彻底关闭**（CI Windows 环境 H-11 + `taskkill /T /F` 分支验证） | CI 或另一台 Windows 机器跑 `tests/heartbeat-worker.spec.ts` H-11 用例，断言 `taskkill /T /F` 分支真实执行；跑通后更新 `M1-验收记录.md` | ⬜ 待执行（Batch 1 准入闸门） |
| 4 | **M3 完成判定全部满足**（milestones §4.5 五条） | 独立复核会话结论 `ACCEPT` | ⬜ 待复核会话 |
| 5 | **本 SPEC §1 待确认（Q1–Q8）已全部裁定** | 见 §1 | ⬜ 待需求方裁定 |
| 6 | 门禁数据底座已在 M1 就位 | `regression_gates` / `gate_evaluations` 表 + 不可变触发器（0013/0014）| ✅ 已核实（无新表迁移即支持规则 CRUD 与留痕） |

---

## 1. 前置裁定与待确认事项（Q0–Q8，**2026-11-16 需求方已全部裁定**，回填见 §1.10）

> 起草时（v0.1）本节为待裁定清单；v0.2 起各项结论以「裁定」行回填在原位，
> 汇总表见 §1.10。裁定前后的完整论证保留不删（工程规则 §10 惯例）。

> 裁定原则：凡与事实源冲突的预期（含本 SPEC 起草时收到的口头目标），一律**先指出冲突、
> 给出选项与建议、停下等裁定**——不静默改架构，也不静默缩范围。

### Q0 · M3 合并与 tag 状态核实（阻塞 Batch 1）

**背景**：口头预期「M3 已复核通过并已合并/打 tag」，但 2026-11-17 实测 origin/main =
`1a4c00e`（不含 M3 七笔提交链），tag 只有 `v0.1.0-m1`/`v0.1.0-m2`，**无 `v0.1.0-m3`**。

**待裁定**：M3 的独立复核（Batch 5 惯例）是否已完成？若复核通过，由谁执行合并 +
打 `v0.1.0-m3`？在合并前，M4 的 Batch 1 遗留补验**不得开工**（milestones §5.4：
M4 前置 = M3 完成判定全部满足）。

### Q1 · CI 集成架构：拉取模式（事实源现状）vs 推入模式（口头预期）——**本 SPEC 最大的裁定项**

**两个事实源现状**：

- `milestones.md` §5.2：`GET /api/gates/results/{runId}` **只输出结构化 JSON**，
  由 GitHub Actions 读取后写 PR 评论；§5.3：**平台永不持有 GitHub PAT**（`工程规则.md` §9）；
- `contracts/src/api.ts` 已锁 `GateResultResponse`（CI 拉取的实现边界）；
- openapi 已有 `/api/gates/results/{runId}` 路径。

**口头预期**（本次 M4 启动指令）：「平台接收 GitHub PR 事件 Webhook → 校验签名 →
触发跑批」+「跑批完成后向 GitHub API 回传 Commit Status 或 PR 评论」——这是
**推入模式（platform-push）**：平台需要 ① 暴露公网可达的 Webhook 入站端点；
② 持有 GitHub 凭证（PAT / GitHub App）调用 GitHub API 写评论与 Commit Status。
**两者都与已锁事实源直接冲突**（`工程规则.md` §9「平台永不持有 GitHub PAT」；
`GateChannel.kind` 枚举只有 `feishu` / `wecom` / `webhook`，无 `github`）。

**注意**：`US-018` 故事标题确实写了「门禁结果推送（飞书 / 企微 / **GitHub PR**）」，
但其依赖注明「US-021（若需 PR 触发）」、`GateChannel` 无 github 种类——事实源内部
本身存在张力，M1 时以「CI 拉取」口径收窄落地。

**选项**：

- **A. 维持拉取模式**（事实源现状）：平台只做 `GET /api/gates/results/{runId}`；
  GitHub Actions 由需求方在自己的仓库配置 workflow（拉 JSON → 判 overall → 写评论 /
  Commit Status）。平台**零 GitHub 凭证、零公网端点**。Webhook 一词在事实源中的落点
  仅是「飞书 / 企微出站 Webhook」（US-018）。
  - 代价：PR 触发评测跑批这一需求**不在本模式内**（CI 侧自行决定何时调平台 API
    触发跑批——平台已有 `POST /api/runs`，CI 可直接调）。
- **B. 反转为推入模式**（口头预期全量落地）：平台新增入站 Webhook 端点（GitHub PR 事件
  → HMAC-SHA256 签名校验 → 防重放 → 映射到评测集触发跑批）+ 出站 GitHub 集成
  （Commit Status / PR 评论，持有凭证）。**契约扩展**：`GateChannel` 增 `github` 种类、
  新增入站 Webhook 配置形状、PR → 评测集绑定配置（repo → dataset/target 映射）、
  Webhook 投递留痕表；**安全面扩大**（公网端点、签名、防重放、凭证存储）。
- **C. 分层折中**：M4 先落 A（事实源范围 + 门禁规则 CRUD + 成本台账 + 算子库 + T2），
  推入模式（PR 触发 + GitHub 回传）作为**独立裁定项**挂在 M4 末尾或 M5——不动已锁架构。

**本 SPEC 建议 C**（维持事实源、增量演进；推入模式的公网/凭证/映射三座大山不宜与
台账/算子库混在一个里程碑里），但**最终以需求方裁定为准**。裁定直接影响 §2 的
Batch 2/Batch 3 内容与 §3 不做什么清单。

**裁定（2026-11-16，需求方）**：**全盘采用建议 C（拉取模式）**。事实源锁得很对
（`工程规则.md` §9 与 `GateChannel` 枚举）。M4 不碰公网端点、不存 GitHub PAT、
不做 Webhook 签名（Q2 顺延），平台只负责提供拉取 JSON 的接口；推入模式（PR 触发 +
回传）作为 **M5 议题**。

### 1.10 裁定回填汇总（2026-11-16，九项全部关闭）

| # | 议题 | 裁定 |
|---|---|---|
| Q0 | M3 合并与 tag | **复核 REJECT**（waitForTimeout 未清理 + SPEC-M3 §6 自检记录未写）。不能合并、不能打 `v0.1.0-m3`；**Batch 1（U-1 CI 关闭 + M2 未验证补验）无限期推迟**至 M3 修补完成并复核通过 |
| Q1 | CI 集成架构 | **C 拉取模式全盘采用**；推入模式（PR 触发 + 回传）顺延 M5 |
| Q2 | Webhook 签名 | **顺延**（随推入模式归 M5） |
| Q3 | 三级门禁 | 展示标签；判定复用现有 `GateCondition` 模型，不扩数据结构 |
| Q4 | Markdown 报告 | CI 侧脚本渲染，平台只出 JSON |
| Q5 | 台账维度 | `US-019` 四维（时间/模型/评测集/发起人），无项目维度 |
| Q6 | 成本大盘页面 | **PG-10**（按事实源） |
| Q7 | US-016 / US-021 | 保留在 M4；T2 落 Batch 4 |
| Q8 | CI 联调环境 | 自托管 runner 本地跑；真实厂商 Key 走本地 `.env` 不入库 |

> **Q0 的连带影响（如实记录）**：Batch 1 推迟 ⇒ §2 的批次顺序调整为
> **Batch 2 → 3 → 4 并行先行**（需求方 2026-11-16 指令「完成 M4 的开发」），
> Batch 1 与 Batch 5（真实 CI 联调）在 M3 复核通过后补位——与 milestones §5.4
> 「M4 前置 = M3 完成判定」的原始顺序存在**已批准的偏离**，见 §5 差异表。
> 另：M3 修补会话已提交 `27f83d1`（三份测试文件的条件等待替换，51/51 绿），
> 但 **SPEC-M3 §6 自检记录仍为空模板**——修补未完，复核前提未兑现。

### Q2 · Webhook 签名算法与防重放（若 Q1 裁定含推入模式）

- GitHub 出站 Webhook 签名为 **HMAC-SHA256**（`X-Hub-Signature-256`，secret 为
  仓库/App 级配置）；GitLab 为 token 明文比对。**建议**：MVP 仅支持 GitHub
  （`X-Hub-Signature-256` + 常量时间比较），防重放 = `X-GitHub-Delivery` GUID 唯一键
  落幂等表（可复用 `gateway_idempotency` 的模式建投递留痕）。
- Secret 存储：复用 M2 的 AES-256-GCM cipher（`provider-key-cipher` 同型），密文入库。

### Q3 · 「三级门禁（L1 红线 / L2 水位 / L3 退化）」与现有门禁模型的映射

现有契约：`GateMetric`（score_overall / pass_rate / coverage? / regression_pct）、
`GateCondition`（metric + op + value）、`GateAction`（BLOCK / WARN）——**表达力已覆盖**
三类条件的判定，但「三级」的**分级语义**未定义。建议映射（待确认）：

| 级 | 语义 | 现有模型落点 | 判定动作 |
|---|---|---|---|
| L1 红线 | 绝对分数红线（如 score_overall < 0.85） | `GateCondition{metric:score_overall, op:'<', value:0.85}` | BLOCK |
| L2 水位 | 可用性水位（pass_rate / coverage 低于水位线） | `GateCondition{metric:pass_rate|coverage, op:'<', value}` | WARN 或 BLOCK（按规则配置） |
| L3 退化 | 相对已确认 baseline 的退化超阈值 | `GateCondition{metric:regression_pct, op:'>', value}`（`BL-2`：永远相对已确认 baseline） | BLOCK |

**建议**：三级 = 门禁规则上的**分类标签/优先级语义**（文档 + 展示层），判定引擎复用
现有 `GateCondition` 单条件模型，不新增三级数据结构。若需求方要「三级各自硬编码不可
配置」或「同规则内多条件 AND/OR 组合」，则是契约扩展，需单独裁定。

### Q4 · Markdown 报告的渲染归属

- 拉取模式（A/C）：JSON 即契约；Markdown 由 CI 侧渲染（GitHub Actions 的
  `gh pr comment` 前自行拼装）——平台不新增 Markdown 端点。
- 推入模式（B）：平台需新增 **Markdown 渲染模块**（`GateResultEnvelope` → Markdown），
  并定义 PR 评论的模板口径（头部门禁结论 / 退化表 / 链接回 PG-03）。
**建议**：渲染归属跟随 Q1 的裁定。

### Q5 · 成本台账维度对齐

口头预期「按**项目**、按模型、按时间段聚合」vs `US-019` 事实源「**时间、模型、评测集、
发起人**四维 + 下钻 PG-03」。MVP 单租户无「项目」概念（OUT-4 明确不做多租户/项目空间）。
**建议**：按 `US-019` 四维执行（评测集维度已覆盖「按项目」的意图）；「项目」维度待
多租户时代再说。另：台账口径红线（milestones §5.3）——M1 fixture provider 行必须排除
（`is_active=false` 且无历史真实费用）。

### Q6 · 页面归属对齐

口头预期「成本对账大盘 **PG-09**」vs 事实源「成本台账 = **PG-10**（独立页面）；
`PG-09` = 管理配置（模型网关 Tab + M4 增门禁规则 Tab / 推送渠道 Tab）」。
**建议**：按事实源——PG-10 承载成本大盘，PG-09 增门禁规则 / 推送渠道两个 Tab
（`US-017` / `US-018` 的呈现层）。

### Q7 · `US-016` 算子库与 `US-021` T2 Target 是否仍在本里程碑

`milestones.md` §5.2 明列两者；本次口头预期的批次拆解未点名。**建议**：保留在 M4
（不得自行缩小 milestones 范围）：`US-016`（PG-07 算子库：内置算子只读清单 + 裁判
模板 CRUD + 另存为模板，完成判定含 `PT-1` 快照不变）落在 Batch 4；`US-021`（T2 外部
HTTP Target，`TARGET_T2_ENABLED` 开关 + `authHeader` 密文入库）落 Batch 4 或按容量
顺延至 M4 末——**需明确裁定**，因为它同时是 `US-018` PR 触发的依赖（若需）。

### Q8 · INT 真实 CI 联调的环境与凭证

真实 PR 联调需要：① 一个可发起 PR 的 GitHub 仓库（`qingfeng092802/Evaluation-Middle-Platform`
私有仓库是否可用？Actions 的 windows-latest 分钟数是否可接受？）；② 平台侧的可达地址
（GitHub Actions runner 访问本地平台需要公网隧道或自托管 runner——**推入模式下还要
GitHub → 平台的入站可达**）；③ 真实厂商 API Key（Batch 1 补验与 INT 都需要，仅存
本地 `.env`）。**建议**：INT 用「自托管 runner 跑在与平台同机」回避公网暴露；凭证
全部走 `.env` 不入库。具体拓扑待裁定。

### Q9 · 契约缺失盘点（裁定后按 §1.7 流程单独成笔 `contracts(M4):`）

| 缺失项 | 现状 | 需要的扩展（若 Q1=B/C 相关项） |
|---|---|---|
| 门禁规则 CRUD | ✅ 契约已有（`RegressionGateCreate/Update/Gate`、openapi `/api/gates*`） | 无 |
| CI 结果拉取 | ✅ 已有（`GateResultResponse` + `GateResultEnvelope`、`/api/gates/results/{runId}`） | 无 |
| 成本聚合端点 | ❌ 无（openapi 无 /api/cost* 或 /api/ledger*） | 新增聚合查询形状（维度/粒度/过滤） |
| 推送渠道回调 Token | ✅ 契约已有（`CallbackTokenResponse`）；**存储表无** | 新表或复用（token 哈希入库 + expiresAt） |
| Webhook 投递留痕 | ❌ 无 | 幂等表（delivery GUID 唯一）——Q2 裁定后 |
| `GateChannel.github` 种类 + 凭证 | ❌ 无（枚举仅 feishu/wecom/webhook） | Q1=B 才需要 |
| PR → 评测集绑定 | ❌ 无 | Q1=B 才需要 |
| 三级门禁标签 | ❌ 无（若裁定为规则分类标签则加列；复用条件模型则不加） | Q3 裁定后 |

**存量可复用数据底座（无新表迁移即支持）**：`regression_gates`（规则，含 `channels`
jsonb）/ `gate_evaluations`（留痕，不可变）/ `eval_runs.cost_*`（台账聚合源）/
`model_prices`（成本口径唯一事实源 `TS-2`）。

---

## 2. 批次编排

> **串行主线 + 每批一笔**。批次内容以 §1 裁定结果为准——Q1（架构方向）未裁定前，
> Batch 2/3 的范围**冻结**；Batch 1 的准入闸门（Q0 核实 + M2 补验 + U-1 关闭）独立于
> Q1 可先行。

### Batch 1 · 遗留项补验 + M3 收尾核实（准入闸门，无业务代码）

**准入条件**：§0 检查 1（M3 合并/tag）核实通过。

**任务**

- `[INT-M4-00a]` M3 独立复核 + 合并 + `v0.1.0-m3`（Q0 裁定后执行）
- `[INT-M4-00b]` **U-1 关闭**：CI Windows 环境（或另一台 Windows 机器）跑 H-11，
  断言 `taskkill /T /F` 子孙清理分支真实执行；跑通后更新 `M1-验收记录.md` §13.4
- `[INT-M4-00c]` **M2 未验证项补验**：`docker compose --profile gateway up` 拉起真实
  LiteLLM 容器 → 配置真实厂商 Key → 跑一次真实 LLM-as-a-Judge 评测 → 断言路由 /
  并发限流 / 超时 / 流式解析 / `model_prices` 计费在真容器下成立；补验浏览器
  `EventSource`（真实浏览器 SSE 断线重连）
- `[BE-M4-01]` 契约扩展笔 `contracts(M4):`（内容随 Q1–Q8 裁定，见 §1.9 清单）

**准出条件（缺一不可）**

- [ ] U-1 固定口径改写为「已验证」并留 CI 读数（`M1-验收记录.md` §13.4）
- [ ] LiteLLM 真容器跑批读数留档（限流 / 超时 / 流式 / 计费四项）
- [ ] EventSource 真浏览器断线重连读数留档
- [ ] 契约扩展单独成笔（若裁定需要），`typecheck` + `lint` 绿
- [ ] `npm run typecheck && npm run lint:design && npm test` 退出码 0

### Batch 2 · [BE] 门禁规则配置 + （按 Q1）Webhook 接收与鉴权

**任务（按 Q1 裁定裁剪）**

- `[BE-M4-02]` 门禁规则 CRUD 落地（契约已有）：`POST/GET/PATCH /api/gates`，
  `gate_evaluations` 判定留痕走不可变触发器
- `[BE-M4-03]`（Q1=B）入站 Webhook 端点：GitHub PR 事件 → HMAC-SHA256 校验
  （常量时间比较）→ delivery 幂等 → PR → 评测集映射 → `POST /api/runs` 触发跑批
- `[FE-M4-04]` `PG-09` 门禁规则 Tab（`US-017` 呈现层）

**准出条件（缺一不可）**

- [ ] 非法签名 → 401/403，**不触发跑批、不留痕**（行为级断言）
- [ ] 合法签名 + 重放同 delivery → 幂等不重复触发
- [ ] 规则 CRUD 全链路单测 + 留痕不可变断言（`reject_mutation()`）
- [ ] 门禁批结束时提交一次

### Batch 3 · [BE] 门禁判定引擎与结果出口（按 Q1/Q4 裁定）

**任务**

- `[BE-M4-05]` 判定引擎：跑批终态 → 逐规则求值（L1/L2/L3 映射，Q3 裁定）→
  `gate_evaluations` 留痕 → `GateResultEnvelope` 组装（复用契约，不自造形状）
- `[BE-M4-06]` 结果出口：拉取模式 = `GET /api/gates/results/{runId}` 落地；
  推入模式 = Commit Status / PR 评论回传 + Markdown 渲染（Q4）
- `[BE-M4-07]` `US-018` 飞书 / 企微出站 Webhook + 回调 Token（明文仅返回一次）

**准出条件（缺一不可）**

- [ ] 阻断门禁 → `overall=FAIL`；无规则 → `NO_GATE`；WARN 只告警不阻断
- [ ] 留痕不可变断言（`reject_mutation()`）
- [ ] 出站渠道失败不吞错（重试/失败留痕口径待 Q1 裁定后细化）
- [ ] 门禁批结束时提交一次

### Batch 4 · [BE] 成本聚合 + [FE] 大盘与配置页 + `US-016` / `US-021`

**任务**

- `[BE-M4-08]` 成本聚合端点（Q5 四维 + fixture 排除口径；契约扩展按 §1.9）
- `[FE-M4-09]` `PG-10` 成本台账大盘：四维切换 + 下钻 `PG-03` + 图表/表格孪生
  （红线 3）+ ECharts 主题走 Token（红线 10）
- `[FE-M4-10]` `PG-09` 推送渠道 Tab（`US-018`，回调 Token 明文仅返回一次）
- `[FE-M4-11]` `PG-07` 算子库（`US-016`，若 Q7 裁定保留）
- `[BE-M4-12]` `US-021` T2 Target（若 Q7 裁定保留；`TARGET_T2_ENABLED` 开关）

**准出条件（缺一不可）**

- [ ] 台账四维汇总与 `eval_runs.cost_total` 逐行求和**误差 0**（fixture 行排除断言）
- [ ] 裁判模板另存后新 EvalRun 引用模板版本、历史 `config` 不变（`PT-1`）
- [ ] T2 端点响应与日志**不出现**鉴权 Header 明文
- [ ] 门禁批结束时提交一次

### Batch 5 · [INT] 真实 CI 联调 + 安全加固收尾 + 独立复核

**任务**

- `[INT-M4-13]` 真实 CI 联调：测试仓库发起 PR → （按 Q1 架构）触发 → 跑批 →
  CI 拿到红/绿信号 → PR 评论/Status 落地
- `[INT-M4-14]` 安全加固收尾：`getsentry/skills` 审计、依赖与密钥扫描、`.gitignore` 复核
- `[INT-M4-15]` 独立验收复核（全新上下文会话）→ MVP 发布准备

**准出条件（缺一不可）**

- [ ] 真实 PR 端到端：触发 → 跑批 → 红/绿信号全链路留痕
- [ ] 复核结论 `ACCEPT` → 打 `v0.1.0` 正式 tag（需授权）

### Given / When / Then 验收条件（行为级，8 条）

| # | Given | When | Then |
|---|---|---|---|
| G1 | 已配置门禁规则与合法 secret 的 Webhook 端点 | 收到**签名不匹配**的 PR 事件 | 401/403 拒绝，**不触发跑批、不留痕、不回传** |
| G2 | 同一 delivery GUID 已成功处理 | 收到**同 GUID 重放**（签名合法） | 幂等：不重复触发跑批，投递留痕仅一行 |
| G3 | 触发了含 **L1 红线 BLOCK** 规则的评测集，跑批后 `score_overall < 0.85` | CI 拉取结果（或接收回传） | `overall=FAIL` + 对应 `gate_evaluations` 留痕；推送模式下 CI 侧拿到**失败信号**（Commit Status=failure 或 422，随 Q1 裁定） |
| G4 | 门禁通过 | CI 拉取/接收结果 | `overall=PASS`，PR 评论 Markdown 含退化表与链接（推送模式）；拉取模式 JSON 可被 `jq` 直接解析 |
| G5 | 数据库中某时间窗的 `eval_case_results` 明细 | 打开 `PG-10` 台账同时间窗 | 四维聚合值与 **SQL 逐行求和误差 0**；fixture provider 行被排除 |
| G6 | 评测集**未配置任何门禁规则** | CI 拉取/接收结果 | `overall=NO_GATE`，**不阻断** CI |
| G7 | 任何门禁判定已落 `gate_evaluations` | 尝试 UPDATE / DELETE 留痕 | `reject_mutation()` 拒绝（409），历史不可改写 |
| G8 | 裁判配置已「另存为模板」 | 以模板发起新 EvalRun | 新 run 快照引用模板版本，**历史 run 的 `config` 逐字不变**（`PT-1`） |

---

## 3. 不做什么（硬约束）

- **不推翻 `工程规则.md` §9**：除非 Q1 明确裁定 B，平台不持有 GitHub PAT、不做 PR 评论
  写入（本 SPEC 的建议态为 C=先维持拉取）
- **不做多租户 / 项目空间**（OUT-4）：台账维度按 `US-019` 四维，不新增「项目」
- **不用估算冒充真实成本**（`US-021` / `TS-2`）：T2 无 usage 记 `unknown`；成本口径
  只出自 `model_prices`
- **不做门禁留痕的任何改写通道**（`reject_mutation()` 不可绕）
- **不新增三级门禁的独立数据结构**（除非 Q3 裁定；现有 `GateCondition` 模型优先复用）
- **不做事件回放**（`PROGRESS_RESUME_POLICY.snapshot_only` 不变）
- **不把「跳过」当「通过」**；不删弱断言；契约扩展单独成笔 `contracts(M4):`
- **不承接 M5+ 内容**（GitHub App 全量集成、多平台 Webhook、真实公网部署拓扑——除非 Q1/Q8 裁定）

---

## 4. 与 M3 的衔接

| 项 | M3 状态 | M4 动作 |
|---|---|---|
| 已确认基线（`baselines` + `ux_baselines_one_confirmed`） | M3 交付 | `L3 退化` 判定的**唯一锚点**（`BL-2`）；无确认基线的评测集，L3 规则不判定并在结果中注明 |
| `POST /api/runs` 触发跑批 | M1/M2 交付 | Webhook/CI 触发复用同一入口（不另造触发路径） |
| `GateResultEnvelope` / `GateResultResponse` | M1 契约已锁 | M4 落地 `/api/gates/results/{runId}`，形状逐字不加字段 |
| `eval_runs.cost_*` + `model_prices` | M1/M2 交付 | 台账聚合唯一数据源（`TS-2`） |
| Role Switcher（`X-Role`） | M3 交付 | `PG-09` 门禁规则 / 推送渠道 Tab 的 ROLE-B 语义沿用 |
| `CaseDiffSheet` 双栏抽屉 | M3 交付 | 台账下钻 `PG-03` 的交互惯例沿用（J/K / Esc / 焦点归还） |
| `PROGRESS_RESUME_POLICY` | M2 拍板 `snapshot_only` | 不变 |

---

## 5. 与原始编排的差异（须记录，不得静默）

| 项 | 原始编排（milestones §5 / 事实源） | 口头预期 / 实际 | 状态 |
|---|---|---|---|
| CI 集成方向 | CI **拉取** JSON；平台永不持有 GitHub PAT | 口头预期：平台**接收** PR Webhook 触发跑批 + **回传** Commit Status / PR 评论 | ⏸ **Q1 待裁定**（本 SPEC 建议态 = C 分层折中） |
| 门禁模型 | 单条件 `GateCondition`（BLOCK/WARN） | 口头预期：「三级门禁 L1/L2/L3」 | ⏸ **Q3 待裁定**（建议 = 分类标签映射现有模型） |
| 台账维度 | 时间 / 模型 / 评测集 / 发起人 | 口头预期：按项目 / 模型 / 时间段 | ⏸ **Q5 待裁定**（建议 = 按 US-019 四维） |
| 成本大盘页面 | `PG-10` | 口头预期：PG-09 | ⏸ **Q6 待裁定**（建议 = 按事实源 PG-10） |
| `US-016` / `US-021` | milestones §5.2 明列 | 口头预期批次拆解未点名 | ⏸ **Q7 待裁定**（建议 = 保留在 M4） |
| M3 合并 / tag | — | 口头预期「已合并/打 tag」 | 🔴 **实测未合并**（见 §0 检查 1 / Q0） |

---

## 6. 研发自检记录（Batch 完成后填写，当前为空模板）

> 本节由研发侧在 M4 最后一个 commit 前填写，对应各 Batch 准出条件。
> **「已通过」只对实跑过的检查项成立**；未跑的项目必须显式列为「未验证」。

### 6.1 提交信息（待填）

### 6.2 批次完成情况（待填）

### 6.3 机械门禁实测（待填：每条读数必须写明环境条件；`npm test` 必须写 N passed / M skipped）

### 6.4 未验证范围（如实列出，不写「应该没问题」）

（初始沿承：U-1 关闭前的 `taskkill` 分支、真实厂商网关、LiteLLM 真容器、浏览器
`EventSource`、`e2e-fail.ts` 原样运行——处置随 Batch 1 补验结果更新。）
