# 开发里程碑规划（M1 … M4）

> **本文件是「开发里程碑划分与故事归属」的唯一事实源。**
>
> 它**不重复**任何产品 / 技术事实，只回答一件产品文档回答不了的事：
> **先做哪一块、后做哪一块、每一块的边界在哪、做完算不算完。**
>
> 引用关系（违反即为重复维护）：
>
> | 要查什么 | 去哪查 |
> |---|---|
> | 故事内容与优先级 | [`../facts/user-stories.md`](../facts/user-stories.md)（`US-001`…`US-021`） |
> | 页面结构 / 按钮文案 / 状态机 / 拒绝清单 | [`../facts/pages-and-flows.md`](../facts/pages-and-flows.md)（`PG-01`…`PG-10`、`RS-01`…`RS-06`） |
> | 架构选型 / 两条 P0 链路 / 评分口径 | [`../facts/technical-solution.md`](../facts/technical-solution.md)（`TS-1`…`TS-5`、`OPEN-1`…`OPEN-5`） |
> | 表结构 / 索引 / 不可变触发器 / 迁移断言 | [`../facts/database-schema.md`](../facts/database-schema.md)（15 表、17 触发器、`T-01`…`T-22`） |
> | 视觉与交互硬约束 | [`../facts/DESIGN.md`](../facts/DESIGN.md)（Token、`tabular-nums`、`AS-1`…`AS-3`） |
> | 接口 / 数据契约 | [`../../src/contracts/`](../../src/contracts/) |
> | 工程门禁（TDD / 真栈验收 / 安全） | [`../工程规则.md`](../工程规则.md) |
>
> 建立日期：2026-11-07 · 状态：**已确认**（需求方 2026-11-07 拍板）

---

## 0. 拆分原则（SDD）

1. **每个里程碑必须能独立演示、独立通过真栈验收。** 不允许「四个里程碑一起跑通才算完」——
   那等于没有里程碑，只有一次大爆炸式交付。
2. **每个里程碑结束时 `main` 是可运行、可登录、可用真实数据操作的状态。**
   不存在「M2 的代码补上 M1 才能用」这种倒挂。
3. **口径与地基不往后推。** 状态机、不可变红线、成本计算出口、`EvaluatorOperator` 接口
   全部在前两个里程碑落地。后期只做增量，不做重构。
4. **宁可少交付一个页面，不可交付一个假页面。** 没有真实数据源支撑的界面一律不做，
   列入该里程碑的「明确不做」。
5. **P2 不建页面**（`pages-and-flows.md` `PF-2`）。`US-012` 在任何里程碑中都不产生界面。

---

## 1. 里程碑总览

| # | 名称 | 定位 | 归属故事 | 交付页面 |
|---|---|---|---|---|
| **M1** | 核心底座与确定性评测闭环 | P0 基石 | `US-001` `US-002` `US-003`(规则) `US-005` `US-006` `US-008` `US-011`(单栏) | `PG-01` `PG-02` `PG-03` `PG-04`(单栏) `PG-05` `PG-06` |
| **M2** | 多模型统一网关、LLM-as-a-Judge 与 SSE 实时并发跑批 | P0 核心 | `US-004` `US-007` `US-014` `US-015` | `PG-02`(补裁判区块) `PG-03`(SSE) `PG-09`(模型网关 Tab) |
| **M3** | 双版本 AB 对比工作台与 Badcase 双栏 Diff 诊断 | P0/P1 杀手锏 | `US-009` `US-010` `US-011`(升级双栏) `US-013` `US-020` | `PG-08` `PG-04`(双栏) `PG-09`(基线确认 Tab) |
| **M4** | CI/CD 回归门禁 Webhook、安全加固与全局成本对账台账 | P1 完备交付 | `US-016` `US-017` `US-018` `US-019` `US-021` | `PG-07` `PG-09`(门禁规则 + 推送渠道 Tab) `PG-10` `PG-06`(区域 4·T2) |

**P0 闭环在 M2 结束时就已完整成立**（`user-stories.md` §1 的九环链路全部落地）。
M3 / M4 是 P1 增强，**不构成「首版能不能用」的判断依据**。

---

## 2. M1 · 核心底座与确定性评测闭环

> 规格正文见 [`SPEC-M1.md`](./SPEC-M1.md)。本节只定边界。

### 2.1 阶段目标

建立**不可变的评测数据底座 + 真实的异步跑批执行层 + 单次运行报告**，
让「导入评测集 → 建 Target → 配规则算子 → 跑批 → 看结果 → 下钻单条」这条链路
在**真实数据库**上完整跑通一次，全程零外部大模型依赖。

### 2.2 为什么这是第一块

- 没有不可变版本，后面所有「对比」都是比较两份会变的东西（`PT-1` / `PT-2`）；
- 没有 worker + 状态机，M2 的 SSE 无处可挂 —— 实时进度是执行层的**观察面**，不是执行层本身；
- 六个确定性规则算子成本为 0、语义可复算，是唯一能在**没有任何外部凭证**时验证「评分口径对不对」的手段。

### 2.3 范围

**做**：

- 全部 15 张表的 DDL + 17 个触发器（14 不可变 + `eval_runs` 2 + `baselines` 1）+ `claim_next_run()` / `reclaim_stale_runs()`（`database-schema.md` §1–§4）
- 六个规则算子实现（`recall_at_k` / `mrr` / `ndcg_at_k` / `json_schema` / `regex` / `numeric_fidelity`）
- 评测集导入（JSONL / CSV）+ 校验报告 + 不可变版本快照
- Target（T1）创建与版本化
- `POST /api/runs` 前置校验 + 入队；worker 领取、并发执行、汇总、落终态
- 僵尸任务回收定时调度（`Q-1`：**不调度等于不存在**）
- `PG-01` / `PG-02`（仅规则算子区块）/ `PG-03`（2s 轮询进度，非 SSE）/ `PG-04` 单栏 / `PG-05` / `PG-06`（T1 表单）

**明确不做**（留到后续里程碑，非缺陷）：

| 不做的事 | 归属 | 原因 |
|---|---|---|
| SSE 实时推流 | M2 | 前端用 2s 轮询拿到**同样形状**的进度载荷，切换成本被压到最小 |
| LLM 裁判算子（`PG-02` 第二个配置区块） | M2 | 需真实裁判模型凭证 |
| `PG-09` 模型网关配置 Tab | M2 | M1 只有 fixture 网关，配置界面此时只能填自检地址，是假功能 |
| 单条 Case 重跑 / 人工改判 | **永不** | `pages-and-flows.md` §7 拒绝清单 |
| Badcase 双栏 Diff | M3 | 需已确认 baseline（`US-020`） |
| 逐条结果多维筛选（得分区间 / 算子 / 退化） | M3 | `US-010` 为 P1；`EvalCaseResultListQuery` 已有字段，M1 只启用 `sortBy` + `order` |
| 中止（`US-014`） | M2 | M1 用 fixture 网关，跑批近乎零成本，中止此刻没有要省的钱 |

### 2.4 前置条件

| # | 条件 | 不满足的后果 |
|---|---|---|
| 1 | `src/contracts/` 通过 `npm install` + `tsc --noEmit`（其 `README.md` 的编译状态声明必须在本里程碑内删除） | 契约只是 Markdown 之外的装饰品，业务代码不得依赖未经编译的导出 |
| 2 | 本地 PostgreSQL 16 可用（`docker compose up` 或本机实例） | 无法验证任何不可变触发器 |
| 3 | 无外网依赖：`npm install` 有网即可，**运行期**不得访问任何外部地址 | 违反 `technical-solution.md` §0.5 |
| 4 | Tailwind **v3.4** + `tailwind.config.ts` + `shadcn/ui` 脚手架可运行 | `DESIGN.md` §2.8 的 Token 无法落地 |

### 2.5 完成判定

**全部**满足才算 M1 完成（缺一即未完成，不接受「大部分完成」）：

1. `SPEC-M1.md` §4 的 **8 条 Given/When/Then** 全部通过，且由**独立验收 Agent** 在同一次提交上复现；
2. `npm run typecheck` + `npm run lint` + `npm run test` 全绿；
3. 迁移测试 `T-01`…`T-22` 全绿，触发器数 = **17**；
4. 真栈演示：空库 → `docker compose up` → 导入 50 条 → 建 Target → 发起评测 → worker 执行完 → `PG-03` 显示汇总与逐条结果 → 打开 `PG-04` 单栏抽屉。**全程无手写 SQL 修补、无前端写死数据。**
5. `src/contracts/README.md` 的「⚠️ 编译状态声明」**已删除**（前提是 `npm install` + `tsc --noEmit` + `vitest` 真跑通过）。
   **未通过就删除该声明 = 撒谎**，本项即 M1 未完成。

---

## 3. M2 · 多模型统一网关、LLM-as-a-Judge 与 SSE 实时并发跑批

### 3.1 阶段目标

把执行层从「本地回显」换成**真实多模型网关**，并让 `PG-03` 从轮询升级为
**SSE 实时推流**；同时交付 `US-015`（模型网关凭证与单价）与 `US-014`（中止）。

至此 `user-stories.md` §1 的 P0 九环链路**全部具备真实形态**。

### 3.2 范围

**做**：

- LiteLLM sidecar 接入（路由与并发限流），**成本口径仍只由自有 `model_prices` 计算**（`TS-2` 红线）
- `PG-09`「模型网关」Tab：厂商、API Key 掩码保存（`WRITE_ONLY_FIELDS` 的物理兑现）、输入 / 输出千 Token 单价、并发上限
- `PG-02` 步骤 3 补上「LLM 裁判算子」配置区块（`JudgeEvaluatorConfig`：裁判模型、评分 Prompt、`scaleMax`、`passThreshold`）
- 裁判算子实现：一次网关调用 + 结果解析；解析失败 = `PARSE_ERROR`，`score=NULL`
- SSE：`GET /api/runs/:id/stream`（`snapshot` / `case` / `status` / `heartbeat` / `error`），
  服务端 `LISTEN run_progress` 独立连接，worker 写库后 `NOTIFY`
- 前端 `LiveRunProgressBar` 从轮询切到 SSE，**组件 props 不变**（`DESIGN.md` §4.2）
- `POST /api/runs/:id/cancel` + worker 在 Case 边界感知 `cancel_requested_at`
- **摘除 fixture 网关的默认路径**：种子 provider 置 `is_active=false`，`RunPreflight` 不再因它返回 `hasProviderCredentials=true`

### 3.3 关键约束

| 约束 | 说明 |
|---|---|
| **执行层不重构** | M1 已建好的 worker + `claim_next_run` + 状态机**不改结构**，M2 只在写库后加一次 `NOTIFY`。若 M2 需要重构执行层，说明 M1 的落地有问题，应先修 M1 |
| **单条 Case 重试不做**（2026-11-07 拍板） | 首版不做单条重试，坚守 `pages-and-flows.md` §7 拒绝清单，保持状态机简洁 |
| **不做事件回放** | `PROGRESS_RESUME_POLICY.mode = 'snapshot_only'` 已定稿。重连第一步永远是 `GET /api/runs/:id` |
| **新增缺失契约** | `POST /api/providers/{providerId}/probe`（`US-015` 的「连通性测试」）在 `openapi.yaml` 与 `api.ts` 中**尚不存在**，M2 必须先补契约再实现 |

### 3.4 前置条件

- M1 完成判定全部满足；
- 至少一家真实模型厂商凭证可用（本地 `.env`，**不入库**）；
- LiteLLM proxy 可启动（Docker）。

### 3.5 完成判定

1. 真实网关跑通 50 条，`cost_target > 0` 且可被 `model_prices` 逐步复算；
2. 裁判算子参与评测，`cost_judge > 0` 且与 `cost_target` **分列**（`OPEN-3`）；
3. 断网 / 网关 5xx 时：该条 `FAILED`，`score IS NULL`，**不落 0 分**；
4. SSE 断线后按 `technical-solution.md` §3.5 步骤 [6] 重连，进度不倒退、不重复计数；
5. 中止后 `status=CANCELLED`，已产生结果完整保留且不可改（`T-04` 仍绿）；
6. fixture 网关不再出现在默认链路中（演示时须显式指定才会用到它）。

---

## 4. M3 · 双版本 AB 对比工作台与 Badcase 双栏 Diff 诊断

### 4.1 阶段目标

让「这一版比上一版好还是差」变成**一屏可判**的事：
`PG-08` 汇总 + 逐条对比，`PG-04` 从单栏升级为**双栏 Diff 高亮**。

### 4.2 范围

**做**：

- `baselines`：`US-013` 提名（研发）+ `US-020` 确认 / 驳回（管理员，`PG-09` 基线确认 Tab）
- `PG-01` / `PG-03` 的「提名基线」入口；`ux_baselines_one_confirmed` 的 UI 侧表达
- `GET /api/compare`（汇总对比）+ `GET /api/compare/diff`（`RunComparisonDiffResponse`：算子级 Δ + 逐条 Δ + `summary` + `alignmentWarning`）
- `PG-08` 页面：选择器 + 汇总对比表（`MetricDeltaBadge`）+ 逐条对比表；未确认基线横幅
- `PG-04` 升级为 `CaseDiffSheet` 双栏：`diff.add` / `diff.del` 高亮、`+`/`−` 前缀、`J`/`K` 键盘、Tabs（并排 / 行内）
- `US-010`：`PG-03` 工具栏启用得分区间、算子、失败状态、退化筛选

### 4.3 关键约束

| 约束 | 说明 |
|---|---|
| **Badcase 回流不做**（2026-11-07 拍板） | `US-012` 是 P2，M3 不为它买单。M3 精力聚焦双栏 Diff 诊断本身 |
| **对齐前提是硬拒绝** | 两个 Run 的 `dataset_version_id` 不同 → 接口直接拒绝，不出表（`describeIncomparable()`） |
| **缺一侧不得渲染 0** | 任一侧 `score IS NULL` → `NOT_COMPARABLE`，前端渲染「不可比」 |
| **颜色不是唯一编码** | 必须有 `+` / `−` 前缀与方向箭头（`DESIGN.md` §8） |
| **退化永远相对已确认 baseline** | `BL-2`；`PG-08` 未确认基线时横幅必须显示 |

### 4.4 前置条件

M2 完成判定全部满足（尤其：两次真实跑批可复现地产生可比较的逐条结果）。

### 4.5 完成判定

1. 任意两次同版本 Run 可对比；跨版本 Run 被拒绝且给出明确原因；
2. 逐条 Δ 与算子级 Δ 可手工复算一致（抽查 5 条）；
3. `PG-04` 双栏 Diff 中每条删除行带 `−`、新增行带 `+`，仅凭文字即可分辨；
4. `J`/`K` 在 `input` / `textarea` / `select` / `contenteditable` 内**不生效**；
5. 提名 → 确认链路走通，第二次 `CONFIRMED` 插入被拒（`T-07` 仍绿）。

---

## 5. M4 · CI/CD 回归门禁 Webhook、安全加固与全局成本对账台账

### 5.1 阶段目标

让评测结论**离开平台也能起作用**：门禁规则 → 结构化 JSON 结果 → CI 侧消费；
并补齐成本对账与算子模板复用两个 P1 效率项。

### 5.2 范围

**做**：

- `regression_gates` / `gate_evaluations`：`US-017` 门禁规则配置（`PG-09` 门禁规则 Tab）
- `GET /api/gates/results/{runId}`：**只输出结构化 JSON**，由 GitHub Actions 读取后写 PR 评论
- `US-018` 推送渠道：飞书 / 企微 Webhook + 回调 Token（`CallbackTokenResponse`，明文仅返回一次）
- `US-019` `PG-10` 成本台账：时间 / 模型 / 评测集 / 发起人四维切换 + 下钻 `PG-03`
- `US-016` `PG-07` 算子库：内置算子只读清单 + 裁判模板 CRUD + 「另存为模板」
- `US-021` T2 外部 HTTP Target：`PG-06` 区域 4，`TARGET_T2_ENABLED` 置 `true`，
  `authHeader` 密文入库、读取侧只回 `hasAuthHeader`
- 安全加固收尾：`getsentry/skills` 审计、依赖与密钥扫描、`.gitignore` 复核

### 5.3 关键约束

| 约束 | 说明 |
|---|---|
| **平台永不持有 GitHub PAT** | 只输出 JSON，写 PR 评论是 CI 侧的事（`工程规则.md` §9） |
| **T2 无 usage 时成本记 `unknown`** | 不得用估算值冒充真实成本（`US-021` 备注） |
| **台账口径** | M1 的 fixture provider 行必须在台账统计中排除（或已 `is_active=false` 且无历史真实费用） |
| **门禁结果不可变** | `gate_evaluations` 走 `reject_mutation()`，留痕表不得改写 |

### 5.4 前置条件

M3 完成判定全部满足（门禁的「相对 baseline 退化」必须先有已确认基线）。

### 5.5 完成判定

1. 一条门禁规则被触发时，`gate_evaluations` 落一行留痕，`GET /api/gates/results/{runId}` 返回可被 CI 直接解析的 JSON；
2. 台账四维汇总与 `eval_runs.cost_total` 逐行求和一致（误差 0）；
3. 裁判模板「另存为模板」后，新 EvalRun 快照引用模板版本，**历史 Run 的 `config` 不变**（`PT-1`）；
4. T2 Target 跑通一次真实 HTTP 端点评测，响应体与任何日志中**不出现**鉴权 Header 明文。

---

## 6. 故事 → 里程碑 覆盖矩阵

> 21 条故事必须全部有归属。缺任何一条 P0/P1，说明规划不完整。

| 故事 | 优先级 | M1 | M2 | M3 | M4 |
|---|---|:--:|:--:|:--:|:--:|
| `US-001` 导入与不可变版本快照 | P0 | ✅ | | | |
| `US-002` 浏览版本 / Case 明细 | P0 | ✅ | | | |
| `US-003` 规则算子配置与计算 | P0 | ✅ | | | |
| `US-004` LLM 裁判算子 | P0 | | ✅ | | |
| `US-005` 创建 Target（T1） | P0 | ✅ | | | |
| `US-006` 发起 EvalRun 并发执行 | P0 | ✅ | | | |
| `US-007` 实时进度与单条耗时 | P0 | 轮询占位 | ✅ SSE | | |
| `US-008` 单次运行报告 | P0 | ✅ | | | |
| `US-011` Badcase 诊断抽屉 | P0 | ✅ 单栏 | | 双栏 | |
| `US-015` 模型网关凭证与单价 | P0 | 种子占位 | ✅ 完整 | | |
| `US-009` 双版本报告对比 | P1 | | | ✅ | |
| `US-010` Badcase 筛选与排序 | P1 | | | ✅ | |
| `US-013` 提名 Baseline | P1 | | | ✅ | |
| `US-014` 中止 EvalRun | P1 | | ✅ | | |
| `US-016` 全局算子模板 | P1 | | | | ✅ |
| `US-017` 门禁规则配置 | P1 | | | | ✅ |
| `US-018` 门禁结果推送 | P1 | | | | ✅ |
| `US-019` Token 成本台账 | P1 | | | | ✅ |
| `US-020` 确认 Baseline | P1 | | | ✅ | |
| `US-021` 接入 T2 外部 HTTP | P1 | | | | ✅ |
| `US-012` 一键回流 | **P2** | — | — | — | —（`PF-2` 不建页面） |

**统计**（10 + 10 + 1 = 21，逐条对得上）：

- **P0 10 条**：M1 收 **7** 条（`US-001` `US-002` `US-003` `US-005` `US-006` `US-008` `US-011`）
  + M2 收 **3** 条（`US-004` `US-007` `US-015`）。
  其中 `US-007`（2s 轮询）与 `US-015`（种子占位）在 M1 有**临时可用形态**，
  M2 升级为完整形态；`US-011` 单栏即其在 M1 的**正式交付**，M3 的双栏是增强而非补完。
- **P1 10 条**：M2 收 1（`US-014`）· M3 收 4（`US-009` `US-010` `US-013` `US-020`）
  · M4 收 5（`US-016` `US-017` `US-018` `US-019` `US-021`）。
- **P2 1 条**：`US-012` 无界面（`PF-2`），仅保留 `case_human_labels` 表与
  `dataset_versions.source='backflow'` 取值 —— 属数据库层的扩展性，不是界面交付。

---

## 7. 跨里程碑的不妥协项

> 这五条**不能**为了某个里程碑的进度而临时让步。违反任何一条，宁可推迟该里程碑。

| # | 不妥协项 | 出处 |
|---|---|---|
| 1 | **不可变红线**：Dataset Version / Case / CaseResult / GateEvaluation / HumanLabel 一经写入永不 `UPDATE` / `DELETE`；EvalRun 终态后整行冻结 | `product-overview.md` §6.1、`database-schema.md` §3 |
| 2 | **执行层骨架不在 M2 重构**：worker + `claim_next_run` + `reclaim_stale_runs` + 状态机在 M1 定型 | `technical-solution.md` `TS-3`、§3.5 异常矩阵 |
| 3 | **成本只由自有 `model_prices` 计算**，LiteLLM 成本统计永不入库 | `technical-solution.md` `TS-2` 红线 |
| 4 | **「EvalRun 可解释，不可复现。」** 原样出现在 `PG-03`，不得改写成「可复现」「结果稳定」 | `technical-solution.md` `OPEN-4` |
| 5 | **禁止 Mock 冒充真栈**：任何界面的数据都必须来自本地数据库；`src/app` 下不得出现写死的 Case / EvalRun 数组 | `工程规则.md` §5、`AGENTS.md` 边界 5 |

---

## 8. 已拍板的范围裁决（2026-11-07）

> 以下六项曾与事实文档存在冲突或归属不明，需求方已逐条拍板。**不再讨论。**

| # | 议题 | 裁决 | 理由 |
|---|---|---|---|
| C-3 | M1 模型输出从哪来 | **方案 A：本地 fixture 网关**（OpenAI 兼容 `/v1/chat/completions`，固定回显）。M2 摘除默认路径 | 保住真实 T1→HTTP 链路、真实 DB 读写、真实状态机，只把昂贵的外部模型换成固定回显 |
| C-1 | 单条 Case 重试 | **移出 M2，首版不做** | 坚守 `pages-and-flows.md` §7 拒绝清单，保持状态机简洁 |
| C-2 | Badcase 回流 | **移出 M3，且全部里程碑均不做** | `US-012` 为 P2；M3 精力聚焦双栏 Diff 本身 |
| PG-04 归属 | 抽屉何时交付 | **M1 交付单栏，M3 升级双栏** | `US-011` 是 P0；没有单栏，M1 的链路是断的 |
| PG-02 归属 | 向导何时交付 | **M1 交付规则算子区块，M2 补裁判算子区块** | 向导本身是 P0 主干，分两步只是把「需要真实凭证的部分」推后 |
| 补充项 | 是否 M1 引入 worker | **是**：worker + `claim_next_run` + 状态机在 M1 建立，前端暂用 2s 轮询代替 SSE | 执行层是跑批的心脏；M2 只需在 worker 写库后加一次 `NOTIFY`，无需重构 |

---

## 9. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-11-07 | 建立本文件 | M1…M4 划分、21 条故事归属矩阵、五条跨里程碑不妥协项、六项范围裁决 |
