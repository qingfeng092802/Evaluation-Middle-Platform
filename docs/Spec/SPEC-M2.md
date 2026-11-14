# SPEC-M2 · 多模型统一网关、LLM-as-a-Judge 与 SSE 实时并发跑批

> **状态**：已定稿，等待「启动 M2 编码」指令。
> **上位事实源**：`docs/Spec/milestones.md` §3（M2 范围）、`docs/facts/technical-solution.md`、
> `docs/facts/pages-and-flows.md`、`docs/facts/DESIGN.md`、`docs/facts/database-schema.md`。
> **冲突时以事实文档为准**，本文件只做**任务分解与验收口径**，不新造产品设定。
>
> 阅读顺序（`AGENTS.md` 约定）：`AGENTS.md` → `docs/工程规则.md` → `docs/facts/` →
> `src/contracts/` → 本文件。

---

## 0. 全局前置检查（Batch 1 开始前逐条确认）

| # | 检查项 | 判定方法 | 状态 |
|---|---|---|---|
| 1 | **M1 已推送到 remote** | `git ls-remote origin main` 返回 `dc04385a0cd1f9069010b03519b55f5e941abf12` | ✅ **2026-11-12 实测通过** |
| 2 | **U-1 已处置** | 见 §1.1 | ✅ 已裁定：**接受挂着，固定口径** |
| 3 | **T-1 / T-5 / T-6 逐条裁定** | 见 §1.2 / §1.4 / §1.5 | ✅ 三条已裁定 |
| 4 | **M2-1 / M2-3 确认为 Must-have** | 见 §1.3 | ✅ 确认为 Must |
| 5 | **契约扩展流程已定** | 见 §1.6 | ✅ 已定为「先扩契约、单独提交锁定」 |

> **前置检查 1 的读数**（2026-11-12 实跑）：
> ```
> $ git ls-remote origin main
> dc04385a0cd1f9069010b03519b55f5e941abf12	refs/heads/main
> ```
> 与本地 `main` 一致。**M1 已备份，M2 编码可以启动。**

---

## 1. 前置裁定（六条，全部已定）

### 1.1 U-1 · H-11 的 `taskkill` 子孙清理分支

**现状**：`tests/heartbeat-worker.spec.ts` 的 `killTree(force)` 在 M1 收口时改为
「先 `child.kill('SIGKILL')`，`taskkill /T /F` 降级为子孙清理兜底」。
本机实测：`SIGKILL` 生效（`killedAfterHeartbeat=true`），但 `taskkill` 分支被
自动模式的安全分类器拒绝，**未被覆盖**。

**裁定（2026-11-12）**：**接受挂着**。

- **固定口径**（每次被问必须原样回答，不得改写成「已验证通过」）：
  > 「H-11 的 `taskkill` 子孙清理分支未覆盖。本机 SIGKILL 生效，taskkill 分支被安全分类器拒绝。
  > 该分支的清理效果需在 CI 或另一台 Windows 机器确认。」
- **写入位置**：本文件 §5、M2 合并说明、`docs/Spec/M1-验收记录.md` §13.4 的 U-1 行。
- **关闭条件**：在 CI 或另一台 Windows 机器跑通
  `npx vitest run tests/heartbeat-worker.spec.ts -t "心跳停止后另一 worker 可回收"`，
  要求 `statusAfterKill=RUNNING`、`reclaimLines≥1`、`resultRows=2`、`perCase ∈ [1,2]`，
  并确认 `taskkill /T /F` 分支真的执行；跑通后在 §13.4 补「CI 已验证」并记录
  CI 环境（OS、Node 版本、kill 权限）。
- **若 CI 是 Linux**：`killTree` 走 `child.kill(signal)`，与 Windows 的 `taskkill /T /F`
  语义不同，**需单独确认**，不得默认「本机绿 = CI 绿」。

### 1.2 T-1 · `PG-01` 的 KPI 指标行

**冲突**：`DESIGN.md` §5.1 把「指标卡（KPI 行）」的应用页写成「`PG-03`、`PG-01`」，
§3.2 也把 KPI 行列为必须 `tabular-nums` 的场景；但 `SPEC-M1` `[FE-03]` 交付物 1
对 `/runs` 只列「列表 + 空状态 + 前置横幅」，**未列 KPI 行**。

**裁定（2026-11-12）**：**M2 维持不加 KPI 行**，同时**修文档口径**消除冲突。

- 把 `DESIGN.md` §5.1 图表清单里「指标卡（KPI 行）」的页面归属由
  **「`PG-03`、`PG-01`」改为「仅 `PG-03`」**；
- §3.2 的 `tabular-nums` 场景保留（`PG-03` 指标卡仍需要），但**删除对 `PG-01` 的暗示**；
- **T-1 关闭**（不再是待办，而是「已裁定为不做，且文档已一致」）。
- **理由**：`/api/runs` 没有跨 run 聚合字段，做 KPI 行必然要么新造聚合接口
  （`SPEC-M1` `T-1` 明确禁止），要么前端自算（违反「数据只来自接口」）。
  两份文档口径不一致比「少一个 KPI 行」危险得多 —— 修文档，不加功能。

> **变更记录要求**：改 `DESIGN.md` 时按 §10 规则「保留原判定 + 追加复核行」，
> 不直接替换原文。

### 1.3 M2-1 / M2-3 的优先级

| 编号 | 内容 | 优先级 | 依据 |
|---|---|---|---|
| **M2-1** | at-least-once 语义下的**重复计费**（worker 真崩溃时在途 Case 被重跑，网关被多调用一次；`cost_target` 与实际账单可能不一致） | **Must-have** | `cost_target` 是产品承诺的读数，不能只做到「接近」。M1 `M1-验收记录.md` §10 已登记，建议方案①（网关侧幂等键去重） |
| **M2-3** | 租约**没有 fencing token**（原 worker 长时间停顿后恢复，会续写已被别人领走的 run 的心跳，导致两个 worker 同时跑同一条 run） | **Must-have** | 方案 A 的固有局限。M1 场景（进程被杀/容器重启）不触发，但「宿主挂起 / GC 长停顿」会触发。彻底解法：单调递增 `claim_epoch`，结果写入与心跳都带 `WHERE claim_epoch = $epoch` |

**裁定（2026-11-12）**：**两者均为 Must-have，不是 Should**，都落在 **Batch 1**。

- **M2-1 落地方式**：网关请求带由 `run_id + case_key` 派生的 **idempotency key**，
  由网关保证同一 key 只计费一次；**不采用**「接受重复计费 + 报告标注」。
- **M2-3 落地方式**：`eval_runs` 增 `claim_epoch bigint NOT NULL DEFAULT 0`；
  `claim_next_run()` 每次领取 `+1` 并返回新 epoch；worker 的心跳与结果写入都带
  `WHERE id = $runId AND claim_epoch = $epoch`，影响行数为 0 即表示「我已不是属主」，
  **立即放弃该 run 且不写任何结果**。

### 1.4 T-5 · 窄视口下表格把文档撑宽

**现状**（M1 实测，真实 Edge）：`/runs` @1024 文档 `1337/1024`、`/datasets` @1024 `1069/1024`、
`/targets` @1024 `1024/1024`；**1440 下三页均正常**（`1440/1440`）。
根因：`DataTable` 的 `div.overflow-x-auto` 未能约束 `<table>` 的 min-content 宽度。

**裁定（2026-11-12）**：**M2 支持视口定为 ≥1440**，T-5 记为**已知缺陷、不修**。

- **依据**：`DESIGN.md` 全文**没有任何最小视口规定**；唯一断点是 §1.2
  「`PG-04` 抽屉 `<sm`（640px）全屏」，那是**抽屉内部**布局，不是全站视口下限。
  `DESIGN.md` §1.2 的布局骨架（侧栏 220px + 内容区）在 1440 下成立。
- **验收口径**：几何断言（不折行、不溢出）只在 **1440** 档做文档级断言；
  1024 档只断言「不折行」（`whitespace-nowrap` 的职责），**不断言文档不溢出**。
- **若将来要求支持 1024**：T-5 由「已知缺陷」升为 **P1 必修**，
  修法是给滚动容器加 `max-w-full`、或给 `<table>` 加 `min-w-0`/`w-max`，
  修完必须**三页一起复核**并补 1024 文档级断言。

### 1.5 T-6 · `PG-04` 抽屉的「上一条 / 下一条」按钮

**现状**：原型有（`ui-reference.html:614-615` 的 `↑ Prev [K]` / `↓ Next [J]`），
`DESIGN.md` §4.3 固定头规则也写了「上一条/下一条」，但 `SPEC-M1` `[FE-03]` 交付物 3
的 `PG-04` 条款只列「五个区块 + 仅『关闭』按钮」。M1 第 4 批**已实现**这两个按钮
（`title` 写明快捷键、单条 Case 时不渲染），并登记为 `SPEC-M1` §6.5 `T-6`。

**裁定（2026-11-12）**：**保留现状，并正式纳入 M2 的 `PG-04` 清单**。

- 在 M2 的 `PG-04` 交付物清单里补上：「固定头含『上一条 / 下一条』按钮，
  `title` 标注快捷键 `K` / `J`；只有一条 Case 时不渲染」；
- **T-6 关闭**（不再是待办，而是「已实现并纳入清单」）。
- **理由**：只给快捷键、不给按钮，用户不读文档就永远不知道 `J`/`K` 存在；
  按钮是快捷键的**可发现性载体**，且不新增接口、不改契约、不增加写操作。

### 1.6 契约扩展流程

**裁定（2026-11-12）**：**先扩契约、单独提交锁定，再写业务代码**。

流程（M2 全程遵守）：

1. 在 `feat/m2-*` 分支上**只改 `src/contracts/`**（新增 schema / 字段 / `WRITE_ONLY_FIELDS` 条目）；
2. 跑 `npm run typecheck`（含契约 workspace）与 `npm run lint`；
3. **单独一笔 commit**，message 前缀 `contracts(M2):`，正文列出新增/变更的 schema 名与理由；
4. 该 commit 之后，后续批次**只读契约**，不得再改；
5. 若中途发现契约缺口，**停下**、另开一笔 `contracts(M2):` 提交，不得与业务代码混在同一笔。

**依据**：`docs/工程规则.md` §3「契约与 SPEC 先行」、§9「契约层只写不读」
（`WRITE_ONLY_FIELDS` 集中在 `src/contracts/src/api.ts`）。

**M2 必须先补的缺失契约**（`milestones.md` §3.3 点名）：

- `POST /api/providers/{providerId}/probe` —— `US-015` 的「连通性测试」，
  在 `openapi.yaml` 与 `api.ts` 中**尚不存在**。

---

## 2. 批次编排

> **串行主线 + 局部并行**。四个开发批次，每批**结束提交一次**，不合并成大 commit。
> Batch 5 独立验收复核**不在开发批次内**，但必须做。

### Batch 1 · 数据底座、Fencing Token 与幂等账本（串行先行）

**包含任务**

- `[BE-M2-01]` 迁移与契约
- `[BE-M2-02]` M2-3 Fencing Token + M2-1 幂等账本

**准入条件**：§0 全局前置检查 1–5 全部通过（**已全部通过**）。

**交付物**

1. `db/migrations/0019_*.sql` 起的新迁移：
   - `eval_runs.claim_epoch bigint NOT NULL DEFAULT 0`（M2-3）
   - 幂等账本表（M2-1）：记录网关调用的 `idempotency_key`，主键唯一，
     用于「同一 key 只计费一次」的判定
   - 配套 `db/migrations/down/0019_*.down.sql`（非递归扫描，不会被 `migrate()` 自动执行）
   - `db/schema/` 与 `docs/facts/database-schema.md` 同步
2. `src/contracts/` 的对应变更（按 §1.6 流程，**单独一笔 commit**）：
   - `POST /api/providers/{providerId}/probe` 的请求/响应 schema
   - `claim_epoch` 在 `EvalRun` 读取形状中的暴露（若需要）
3. `claim_next_run()` 改为返回并递增 `claim_epoch`；
   `reclaim_stale_runs()` 同步处理 epoch 语义
4. worker 的心跳写入与结果写入全部带 `WHERE claim_epoch = $epoch`
5. 单测：
   - **Fencing Token 脑裂拦截**（M2-3）：模拟「旧属主恢复后写入」，
     断言影响行数 0 且不产生结果行
   - **崩溃重跑幂等**（M2-1）：模拟 worker 在途崩溃 → 回收重跑，
     断言同一 `idempotency_key` 只计费一次、`cost_target` 与实际调用次数一致

**准出条件（缺一不可）**

- [ ] `0019+` 迁移实跑通过（**影子库前滚 + 回滚验证**，与 M1 `0018` 同法）
- [ ] Fencing Token 脑裂拦截单测 **100% 绿灯**
- [ ] M2-1 崩溃重跑幂等单测 **100% 绿灯**
- [ ] `npm run typecheck` && `npm run lint:design` && `npm test` 退出码 0
- [ ] **本批次结束时提交一次**，commit message 写清范围
- [ ] 门禁读数写明**环境条件**（种子态 / 有数据态）

---

### Batch 2 · 多模型网关与 LLM-as-a-Judge 引擎

**包含任务**

- `[BE-M2-03]` 多模型网关与分时计费
- `[BE-M2-04]` LLM-as-a-Judge 算子与降级路径

**并行建议**：`[BE-M2-01]` 锁定 `src/contracts/` 之后，可并行启动
`[FE-M2-01]`（网关页与 Judge 配置页 UI 骨架）；**前后端联调须等 `[BE-M2-04]` 绿灯**。

**交付物**

1. LiteLLM sidecar 接入（路由与并发限流）；
   **成本口径仍只由自有 `model_prices` 计算**（`TS-2` 红线，永不采信上游 `cost`/`usage`）
2. `PG-09`「模型网关」Tab：厂商、API Key 掩码保存（`WRITE_ONLY_FIELDS` 物理兑现）、
   输入/输出千 Token 单价、并发上限
3. `PG-02` 步骤 3 补「LLM 裁判算子」配置区块
   （`JudgeEvaluatorConfig`：裁判模型、评分 Prompt、`scaleMax`、`passThreshold`）
4. 裁判算子实现：一次网关调用 + 结果解析；**解析失败 = `PARSE_ERROR`，`score = NULL`**
5. `POST /api/providers/{providerId}/probe` 实现（契约已在 Batch 1 锁定）
6. **摘除 fixture 网关默认路径**：种子 provider 置 `is_active=false`，
   `RunPreflight` 不再因它返回 `hasProviderCredentials=true`

**准出条件（缺一不可）**

- [ ] **API Key 零明文泄露**单测 **100% 绿灯**（任何读取路径只返回 `apiKeyMasked`）
- [ ] **分时计费精度**单测 **100% 绿灯**（`effective_from` 取价、调价只增行不改行）
- [ ] **Judge 非法 JSON 降级**单测 **100% 绿灯**（→ `PARSE_ERROR` + `score IS NULL`，不落 0 分）
- [ ] `npm run typecheck` && `npm run lint:design` && `npm test` 退出码 0
- [ ] **本批次结束时提交一次**
- [ ] 门禁读数写明**环境条件**

---

### Batch 3 · 并发跑批引擎与 SSE 断线续传（核心串行攻坚）

> **⚠️ 范围修正（2026-11-12）**：原编排含 `[BE-M2-06] 失败单条重试`，
> 但 `pages-and-flows.md` §7 拒绝清单明列「**单条 Case 重跑 / 人工改判**：无故事支撑，
> 且属人工评测体系」，`milestones.md` §3.3 也写「单条 Case 重试不做（2026-11-07 拍板）」。
> **已裁定移除 `[BE-M2-06]`**，保持事实源一致。详见 §5「与原始编排的差异」。

**包含任务**

- `[BE-M2-05]` 信号量并发引擎 + SSE `Last-Event-ID` 续传
- `[FE-M2-02]` 前端实时进度与（无重试交互，仅进度）

**准入条件**：Batch 2 全部后端接口与算子单测通过。

**交付物**

1. 并发引擎：按 `model_providers.max_concurrency` 施加信号量，
   **并发峰值不得超过上限**
2. SSE：`GET /api/runs/:id/stream`，事件类型
   `snapshot` / `case` / `status` / `heartbeat` / `error`；
   服务端 `LISTEN run_progress` 独立连接，worker 写库后 `NOTIFY`
3. `Last-Event-ID` 断线续传：重连时按 `technical-solution.md` §3.5 步骤 [6] 处理，
   **进度不倒退、不重复计数**；**零重复计费切片**
4. 前端 `LiveRunProgressBar` 从轮询切到 SSE，**组件 props 不变**（`DESIGN.md` §4.2）
5. `PROGRESS_RESUME_POLICY.mode = 'snapshot_only'`：重连第一步永远是
   `GET /api/runs/:id`，**不做事件回放**

**准出条件（缺一不可）**

- [ ] **并发峰值 ≤ `max_concurrency`** 测试通过（真进程，非 mock）
- [ ] **`Last-Event-ID` 断线补发与零重复计费切片**测试通过
- [ ] `npm run typecheck` && `npm run lint:design` && `npm test` 退出码 0
- [ ] **本批次结束时提交一次**
- [ ] 门禁读数写明环境条件（**有常驻 worker 态是必须的一档**）

---

### Batch 4 · 全链路真栈联调与研发自检收尾

**包含任务**

- `[INT-M2-01]` 真栈联调

**准入条件**：Batch 1–3 全部子任务完成且**无遗留前端 Mock 数据**。

**准出条件（缺一不可）**

- [ ] 全量 `typecheck`、`lint`、L1 单测、L2 真栈切片**全部通过**
- [ ] **本批次结束时提交一次**，这是 **M2 的最后一个 commit**
- [ ] 研发自检记录**追加写入本文件 §6**，写明**固定 Commit Hash** 与
      **门禁读数的环境条件**

---

### Batch 5 · 独立验收复核（不在开发批次内，但必须做）

**执行方式**：Batch 4 完成后，**开一个全新上下文的会话**做复核，**不复用开发会话**。

**复核范围（至少覆盖）**

- [ ] 每批准出条件的**实跑读数**（不是开发 Agent 的自述）
- [ ] 契约扩展是否按 §1.6 定的流程走（`contracts(M2):` 独立提交、后续只读）
- [ ] `T-1`…`T-7` 的裁定是否落到代码（T-1 修文档、T-5 定视口、T-6 纳清单，
      其余四项在 M1 已关闭）
- [ ] U-1 是否仍挂着，**caveat 是否写进合并说明**（口径见 §1.1）
- [ ] 门禁读数的环境条件是否写明（种子态 / 有数据态 / 有 worker 态）

**复核结论**：`ACCEPT` / `ACCEPT with caveat` / `REJECT`。`REJECT` 则回到对应 Batch 修复。

---

## 3. 不做什么（硬约束）

- **不把四个批次合成一个大 commit**
- **不在 M1 没有 remote 备份时启动 M2 编码**（当前已备份，见 §0 检查 1）
- **不跳过 Batch 5 的独立验收复核**
- **不把「跳过」当「通过」**：任何跳过的断言必须显式打印原因，且不计入通过数
- **不重构执行层**（`milestones.md` §3.3）：worker + `claim_next_run` + 状态机结构不变，
  M2 只在写库后加一次 `NOTIFY`
- **不做单条 Case 重试**（`pages-and-flows.md` §7 拒绝清单）
- **不做事件回放**（`PROGRESS_RESUME_POLICY.mode = 'snapshot_only'`）
- **不采信上游成本**（`TS-2` 红线：所有金额只由 `model_prices` 计算）
- **不出现任何 API Key 明文**（`WRITE_ONLY_FIELDS`）

---

## 4. 与 M1 的衔接

| 项 | M1 状态 | M2 动作 |
|---|---|---|
| worker + `claim_next_run` + 状态机 | 已定型 | **不重构**，加 `claim_epoch` 与 `NOTIFY` |
| 心跳租约（`0018`） | 已落地 | 心跳写入加 `WHERE claim_epoch = $epoch` |
| fixture 网关 | 种子 `is_active=true` | **置 `is_active=false`**，摘除默认路径 |
| `PG-03` 进度 | 2s 轮询 | 切 SSE，**组件 props 不变** |
| `PG-02` 步骤 3 | 仅规则算子 | 补「LLM 裁判算子」区块 |
| `PG-09` | 占位路由 | 交付「模型网关」Tab |
| `PG-01` KPI 行 | 不加（T-1） | **仍不加**，改 `DESIGN.md` 口径 |
| `PG-04` 上下条按钮 | 已实现（T-6） | 纳入清单，代码不变 |

---

## 5. 与原始编排的差异（须记录，不得静默）

| 项 | 原始编排 | 实际裁定 | 理由 |
|---|---|---|---|
| `[BE-M2-06]` 失败单条重试 | 在 Batch 3 内 | **移除** | `pages-and-flows.md` §7 拒绝清单明列「单条 Case 重跑 / 人工改判」；`milestones.md` §3.3 亦写「单条 Case 重试不做（2026-11-07 拍板）」。需求方 2026-11-12 裁定移除 |
| 提交笔数 | 每批一次（共 4 笔） | 同（Batch 1–4 各一笔） | 契约变更另计 `contracts(M2):` 独立提交（§1.6），不计入批次提交 |

---

## 6. 【研发自检记录】（Batch 4 完成后填写）

> 本节由研发侧在 M2 最后一个 commit 前填写，对应 §2 Batch 4 准出条件。
> **「已通过」只对实跑过的检查项成立**；未跑的项目必须显式列为「未验证」。

### 6.1 提交信息

| 项 | 值 |
|---|---|
| 分支 | `feat/m2-gateway-sse` |
| 基线 | `dc04385` `merge(M1): 确定性评测闭环首个里程碑（--no-ff）` |
| 提交 | **本笔提交**（M2 最后一个 commit） |
| 合并 | **未合并 `main`**，等待需求方明确授权 |

> **关于「固定 Commit Hash」的自引用说明（如实记录，不回避）**：
> §6 与本笔提交同属一个 commit，**文件内容在写入时无法包含自身的 hash** ——
> 任何写进去的值都会在提交后立刻失效（`--amend` 也只会产生新 hash）。
> 因此这里给出**可机械复验的定位方式**，而不是一个会过期的字面量：
>
> ```bash
> git rev-parse feat/m2-gateway-sse          # 本笔提交（Batch 4）
> git log --oneline dc04385..feat/m2-gateway-sse
> ```
>
> 复核时的期望父链（**这些 hash 是固定的**，可逐条 `git show` 校验）：
>
> | 顺序 | Hash | 标题 |
> |---|---|---|
> | 基线 | `dc04385` | `merge(M1): 确定性评测闭环首个里程碑（--no-ff）` |
> | 文档 | `1f47b8f` | `docs(M2): 定稿 SPEC-M2 并落实 T-1 文档口径` |
> | 契约 | `bdf7c93` | `contracts(M2): 新增 provider probe 契约与 claim_epoch fencing token` |
> | Batch 1 | `982fa1a` | `feat(M2): Batch 1 数据底座、Fencing Token 与幂等账本（0019）` |
> | Batch 2 | `e224cef` | `feat(M2): Batch 2 多模型网关与 LLM-as-a-Judge（0020）` |
> | Batch 3 | `7be5351` | `feat(M2): Batch 3 并发跑批引擎 + SSE 续传` |
> | Batch 4 | 本笔提交 | `feat(M2): Batch 4 全链路真栈联调与研发自检收尾` |

### 6.2 批次完成情况

| 批次 | 状态 | 主要交付物 | Commit |
|---|---|---|---|
| Batch 1 数据底座 / Fencing / 幂等账本 | ✅ 完成 | `0019_claim_epoch.sql`（`claim_epoch` 单调递增 fencing token + `gateway_idempotency` 幂等账本 + `down/` 回滚）；`claim_next_run()` 每次领取 +1；worker 全部写入带 `WHERE claim_epoch = $epoch`；契约与 `docs/facts/database-schema.md` 同步（表 15→16、触发器 17→19） | `982fa1a` |
| Batch 2 多模型网关 / Judge | ✅ 完成 | LiteLLM sidecar 路由表生成（只写 `os.environ` 间接引用、产物禁含计费键）；`PG-09` 模型网关 Tab（Key 掩码、`WRITE_ONLY_FIELDS` 物理兑现、单价、并发上限）；`PG-02` 步骤 3 Judge 配置区块；裁判算子（解析失败 = `PARSE_ERROR` + `score IS NULL`，不落 0 分）；`POST /api/providers/{id}/probe`；fixture provider 置 `is_active=false` 摘除默认路径；AES-256-GCM 落库（缺 `PROVIDER_KEY_SECRET` 即抛错） | `e224cef` |
| Batch 3 并发引擎 / SSE | ✅ 完成 | `effectiveConcurrency()`（`min(run.concurrency, provider.max_concurrency)`）+ `providerLimiter()` 按厂商共享 `p-limit`；`GET /api/runs/{runId}/stream`（先 LISTEN 再取快照、首帧恒为 snapshot、15s 心跳）；`refreshRunProgress`/`finalizeRun` 的 `UPDATE ... RETURNING pg_notify(...)`；前端 `run-stream-client` 状态机 + `use-run-stream`（关掉 `EventSource` 自动重连、30s 静默判死、退避 1s→8s）；`LiveRunProgressBar` 8 个 prop 未改 | `7be5351` |
| Batch 4 真栈联调 | ✅ 完成（**带未验证项，见 §6.4**） | `scripts/pw-local.ts` 新增 `waitUntil()` 并替换 3 份浏览器用例里的 **9 处** `waitForTimeout` 固定等待（真栈联调暴露：`next dev` 冷编译 `/api/datasets/imports/validate` 要 2.8s，而原断言等 2.5s ⇒ 冷缓存必红、热缓存白等）；新增 `tests/pw-local-wait.spec.ts` 4 条（含「超时抛错」的反向验证）；真栈全链路正/负路径实跑；本节自检记录 | 本笔提交 |

### 6.3 机械门禁实测

> **统一环境条件（本节所有读数在同一棵常驻真栈实例上取得，中途未重启）**：
> Windows 11 · Node `v24.18.0` · vitest `2.1.8` ·
> `npm run dev:all` 起的**完整真栈常驻**（Postgres 容器 `eval-platform-db` healthy +
> fixture 网关 `:8787` + 常驻 worker + `next dev` `:3000`）·
> **有数据态** · **有 worker 态**（worker 常驻，实跑过 COMPLETED 与 FAILED 终态）·
> 单测走自动派生的 `eval_platform_test` 库。
>
> **数据量随时间增长（如实标注，避免读数对不上）**：`npm test` 与 `typecheck`/`lint` 一组读数
> 取自 `14:35`（当时 dev 库 5 个评测集 / 5 个版本 / 4 个 Target / 7 次运行 / 350 条 Case 结果）；
> `check:datasets-render`、`e2e-demo`、`e2e-fail` 等价驱动、SSE 实读与浏览器层复跑取自
> `14:45–14:50`（此时因前序实跑新增了 e2e 数据，变为 6 / 6 / 5 / 9 / 450）。
> **两组都是「有数据态」，差别只在数据条数**，不是环境档次不同。

| 门禁 | 命令 | 实测结果 | **环境条件** |
|---|---|---|---|
| 类型（应用） | `npm run typecheck` | ✅ **exit 0**（`tsc --noEmit` 通过，且串联执行契约 workspace） | 无服务依赖；有数据态下实跑 |
| 类型（契约） | `npm run typecheck -w @eval-platform/contracts` | ✅ **exit 0** | 同上 |
| 静态检查 | `npm run lint` | ✅ **exit 0**（`eslint . --max-warnings=0`，0 warning） | 同上 |
| 设计门禁 | `npm run lint:design` | ✅ **exit 0**（`lint` + `stylelint` + `check:tokens`）<br>`[check:tokens] 通过：98 个文件，无裸色值 / 渐变 / 内联样式。` | 同上 |
| 单测 + 真库 | `npm test` | ✅ **exit 0**<br>**54 files / 704 passed，0 skipped**，244.62s | **有数据态 + 有 worker 态 + dev server 态**（三档同时成立） |

**同窗口补充读数（`L2` 真栈切片，均为实跑，非 mock）**

| 切片 | 命令 / 方式 | 实测结果 |
|---|---|---|
| 前端渲染对账 | `npm run check:datasets-render` | ✅ **exit 0**：`/datasets` `apiItems=6 renderedRows=6 statusCount=6`；`/runs` `apiItems=9 renderedRows=9 statusCount=9` |
| 正向全链路 | `npx tsx scripts/e2e-demo.ts` | ✅ **exit 0**：run `94dc8cc4-3e1f-4848-879d-461c9e184c18` 终态 `COMPLETED`，`totalCases=50` / `succeededCases=50` / `scoreOverall=0.6` / `passRate=null`（未设阈值不拿 0 冒充）/ `coverage=1` / 成本全 0 / 分数分布 30 条 1.0 + 20 条 0.0 |
| 负向（网关不可达） | `e2e-fail` 等价驱动（见 §6.4 第 2 行） | ✅ **exit 0**：run `1372425f-76d6-425c-aae8-8319371eca11` 终态 `FAILED`，`succeededCases=0` / `failedCases=50` / **`score_overall IS NULL`**（不落 0 分、不编分数） |
| SSE 真帧（运行中） | `curl -N /api/runs/{id}/stream` 实读 | ✅ `content-type: text/event-stream; charset=utf-8`；帧型计数 `{snapshot:1, status:2, case:50}`；`id` 从 `…:0` 到 `…:52` 且**严格单调、无重复** |
| SSE 断线续传口径 | 带 `Last-Event-ID: …:40` 重连 | ✅ **只回 1 帧 `snapshot`（`id …:0`），无任何事件回放** —— `PROGRESS_RESUME_POLICY.mode='snapshot_only'` 在真栈上成立 |
| 浏览器层（真实 Edge） | `vitest run` 三份 parity/keyboard 用例 | ✅ **3 files / 43 passed，0 skipped**（`datasets-render-parity` 23 / `runs-render-parity` 17 / `run-detail-keyboard` 3），在本棵栈上复跑通过（同一组用例在冷启动栈上另跑过一次，同为 43/43） |

> **与前三批读数的差别（不是退步，是补齐）**：Batch 1/2/3 的 `npm test` 读数分别带
> 8 条 skip（真实浏览器用例因未起服务而跳过，当时明确「不计为通过」）。本批在真栈常驻下重跑，
> **skip = 0**，那 8 条已真正执行并通过。
>
> **一条环境观察（不是产品缺陷，但会误导复核）**：`next dev` 的 jest-worker 子进程池在本次联调中
> **两次**损坏，表现为**任意动态段 API 路由**（`/api/datasets/[id]/versions`、`/api/runs/[runId]`、
> `/api/providers/[providerId]`）持久 500，日志为
> `Failed to generate static paths for …: Jest worker encountered 2 child process exceptions`。
> 三条路由均已声明 `dynamic = 'force-dynamic'` 与 `runtime = 'nodejs'`，**不是缺 dynamic 导出**；
> 重启整个 dev 栈即恢复，重启后同一批路由全部 200。复核时若见到该 500，**先重启栈再判定**，
> 不要记成产品缺陷；反过来，也不能用它解释任何一次**重启后仍复现**的 500。

### 6.4 未验证范围（如实列出，不写「应该没问题」）

| 项 | 原因 |
|---|---|
| **U-1**（H-11 的 `taskkill` 子孙清理分支） | 本机 `taskkill` 被安全分类器拒绝，**未覆盖**。口径见 §1.1。**CI 跑通前不得当作「已验证通过」** |
| `scripts/e2e-fail.ts` **未按原样运行** | 该脚本的前置条件是「fixture 网关**进程**已停」，但 `scripts/dev-all.ts` 是监督进程 —— fixture 一退就会连带收掉 worker 与 `next dev`，栈不可能「半死」地跑这条脚本。本批改用**同错误类**（`ECONNREFUSED`）的等价手段：把 `provider.baseUrl` 指向不监听端口 `127.0.0.1:1`（与 `tests/api.spec.ts` 的 L1 用例同法），断言同一组条件（`FAILED` + `score_overall IS NULL` + 50 条全失败 + 0 条成功），跑完在 `finally` 里还原 `baseUrl`。**未覆盖的是「fixture 进程真的不在」这一前置状态本身**；该脚本仍应在能独立停 fixture 的环境（CI / 分进程部署）跑一遍 |
| **LiteLLM sidecar 未在真容器上验证** | 本次未启动 `eval-platform-litellm`（`docker-compose` 的 `gateway` profile 未拉起），也无真实厂商 Key。现有覆盖仅为**配置产物逐字断言**（`tests/litellm-sidecar.spec.ts`：无明文 Key、无计费键名、停用厂商不进路由表）。**真实路由转发与并发限流未验证** |
| **真实厂商网关未接入** | 全程使用本地 fixture（`本地离线自检（fixture）`，`127.0.0.1:8787`）。**真实厂商的限流、超时、非 200 响应、流式差异均未验证**；真实厂商接入后的分时计费也未与真实账单对账（`TS-2` 只保证口径来自 `model_prices`，不保证与厂商账单一致） |
| **浏览器层 SSE 未覆盖** | 现有 SSE 覆盖为三层：服务端 route 直调（`run-stream-route.spec.ts`）、客户端状态机单测（`run-stream-client.spec.ts`）、真栈 `curl` 实读帧（见 §6.3）。**没有用例驱动真实浏览器里的 `EventSource`**，因此「半开连接 30s 判死」「代理缓冲导致帧延迟」这类**只在真实浏览器 + 真实代理下才出现**的行为未验证 |
| **剩余固定等待未全部替换** | `tests/datasets-render-parity.spec.ts` 仍有 4 处 `waitForTimeout`（`1_200ms`×3 + `300ms`×1），位于 `page.goto` 之后、断言之前，作用是「等水合稳定」而非「等某个可判定的条件」；后续定位器走 Playwright 默认 30s 自动等待，因此未替换。**若将来出现同类冷编译翻车，应从这几处查起** |
