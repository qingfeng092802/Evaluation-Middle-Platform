# SPEC-M3 · 双版本 AB 对比工作台与 Badcase 双栏 Diff 诊断

> **状态**：**v0.2 —— §0 全部通过**（检查 5 于 2026-11-15 需求方重启 dev 栈后取得绿读数
> **54 files / 704 passed / 0 skipped**）；§1 七条裁定已回填（结论 + 理由 + 边界）；
> §1.6 两处复核行已按裁定追加。**Batch 1 可开工，等「启动 M3 编码」指令。**
> **起草依据**：`docs/HANDOFF.md` §6.3 的四条硬要求（结构照抄、§1 逐条列六件、范围锁死
> `milestones.md` §4.2、沿承未验证项显式处置）。
> **上位事实源**：`docs/Spec/milestones.md` §4（M3 范围 / 关键约束 / 完成判定）、
> `docs/facts/pages-and-flows.md`（`PG-08` / `PG-04` 双栏 / 拒绝清单）、
> `docs/facts/database-schema.md`（§2.12–2.14、`ux_baselines_one_confirmed`）、
> `docs/facts/DESIGN.md`、`docs/facts/user-stories.md`（`US-009` `US-010` `US-011` `US-013` `US-020`）、
> `src/contracts/`（compare / baselines 形状已锁定，见 §0 检查 6 读数）。
> **冲突时以事实文档为准**，本文件只做**任务分解与验收口径**，不新造产品设定。
>
> 阅读顺序（`AGENTS.md` §一）：`AGENTS.md` → `docs/工程规则.md` → `docs/facts/`
> （做界面的任务**必须**加读 `docs/facts/DESIGN.md`）→ `src/contracts/` → 本文件。
>
> 起草：2026-11-14（M3 启动前会话，接手自 `HANDOFF.md` §6 启动指令）。

---

## 0. 全局前置检查（Batch 1 开始前逐条确认）

| # | 检查项 | 判定方法 | 状态 |
|---|---|---|---|
| 1 | **M2 已合并入本地 `main`** | `git rev-parse --short HEAD` → `5277fd5`；`git rev-parse 5277fd5^{tree} afe07c6^{tree}` 两值相同（合并无冲突解决漂移） | ✅ **2026-11-14 实测通过** |
| 2 | **M3 启动前六件已裁定** | 见 §1.1–1.6 | ✅ **2026-11-14 全部裁定**（§1.6 为「先列清单、确认后改」，清单已附于 §1.6，不阻塞编码） |
| 3 | **契约扩展流程沿承，前缀 `contracts(M3):`** | 见 §1.7 | ✅ 已定（沿承 2026-11-12 裁定，不重议） |
| 4 | **M2 沿承未验证项的补验处置已裁定** | 见 §1.8 | ✅ **2026-11-14 已裁定**：顺延 M4，M3 不依赖（依赖性核验见 §1.8） |
| 5 | **门禁基线在本机可复现** | 在 `5277fd5` 上重跑 `npm run typecheck` / `lint:design` / `npm test`；M2 基线读数见 `HANDOFF.md` §2.6（704 passed / 0 skipped 等） | ✅ **2026-11-15 实跑通过（档 3 · 需求方重启栈后）**：**54 files / 704 passed / 0 skipped**，255.25s；typecheck / lint:design 均 exit 0。重启前两跑皆红的历史读数保留于下方，判读规则命中「老化诊断成立」支 |
| 6 | **M3 所需契约已锁定** | §0 下方读数逐项列出 | ✅ **2026-11-14 实核通过** |

**检查 1 读数**（2026-11-14 实跑）：

```bash
$ git rev-parse --short HEAD            # 5277fd5
$ git branch -a -v                      # main 5277fd5 [ahead 7] / remotes/origin/main dc04385
$ git status --porcelain -uall          # ?? AGENTS.md / ?? docs/HANDOFF.md（交接未提交项，HANDOFF §7）
```

**检查 6 读数**（M3 所需契约逐项实核，**预期零契约扩展起步**）：

| 类 | 已锁定的形状 / 路径 | 位置 |
|---|---|---|
| Zod · 对比 | `CompareQuery` / `CompareResponse` / `CompareMetricRow` / `CompareCaseRow` | `contracts/src/api.ts:248–305` |
| Zod · Diff | `RunComparisonDiffResponse`（`CompareResponse.extend`，含算子级 Δ + 逐条 Δ + `summary` + `alignmentWarning`） | `contracts/src/eval-contracts.ts:352` |
| 判定函数 | `describeIncomparable()`（跨版本 / 同 run 硬拒绝）、缺一侧 score → `NOT_COMPARABLE` | `contracts/src/eval-contracts.ts:367–384` |
| Zod · 基线 | `BaselineStatus`（`NOMINATED`/`CONFIRMED`/`REJECTED`）/ `BaselineNominate` / `BaselineDecision` / `Baseline`（BL-1/BL-3 权限铁律：提名与决定拆成两个形状） | `contracts/src/gate.ts` |
| OpenAPI | `/api/compare`（:589）/ `/api/compare/diff`（:620）/ `/api/baselines`（:651）/ `/api/baselines/{baselineId}/decision`（:691）/ `/api/baselines/resolution`（:727） | `contracts/openapi.yaml` |
| 数据库 | `0012_baselines.sql`（含 `ux_baselines_one_confirmed` 部分唯一索引 :25）、`trg_baselines_guard` | `db/migrations/`、`contracts/src/db-schema.ts:161` |
| 筛选字段 | `EvalCaseResultListQuery.minScore / maxScore / status / evaluatorKey / regressedOnly`（注释原文「P1 筛选条件，P0 期恒为 undefined」） | `contracts/src/api.ts:117–126` |

> **现状核对**：`HANDOFF.md` §2.5 的 20 个路由**不含** compare / baselines ⇒ **契约已有、实现全缺**。
> M3 是把这些已锁定的契约兑现成路由与界面，不是新造接口。
>
> **一处注释口径过期（不阻塞，随 §1.6 文档修正一并处置）**：`contracts/src/gate.ts` 文件头仍写
> 「⚠️ 未编译验证，详见 README.md」，而 `npm run typecheck`（含契约 workspace）在 `5277fd5` 实测
> exit 0（`HANDOFF.md` §2.6）。以实测为准；注释是否清理归入 §1.6 的文档裁定。

**检查 5 读数（2026-11-14/15 · 档 3 = 有服务有数据；dev 库 9 runs / 6 datasets / 450 results 全程未变）**：

| 时点 | typecheck | lint:design | `npm test` | 判定 |
|---|---|---|---|---|
| 2026-11-14 · 重启前（11 小时未重启的老栈） | exit 0 | exit 0（check:tokens 98 文件通过） | 跑 1：exit 1，**4 failed** / 700 passed（386.37s）；跑 2：exit 1，**1 failed / 3 skipped** / 700 passed（293.94s） | 失败全在浏览器层 `waitUntil` / discovery 超时且**漂移**；无 jest-worker 500；空闲 API 0.2–0.3s |
| 2026-11-15 · **需求方重启 `dev:all` 后** | exit 0 | exit 0 | **exit 0：54 files / 704 passed / 0 skipped，255.25s** | **✅ 正式档 3 读数** |

- **判读规则（需求方 2026-11-15 先行写死）**：新读数绿 ⇒ 「11 小时未重启的 dev 栈满量负载退化」诊断成立、取新读数；仍红同形态 ⇒ 非老化、停（≤2 跑）；换形态 ⇒ 停 + 失败画像。**实际命中第一支。**
- 重启前失败画像（保留，不改写）：跑 1 = `run-detail-keyboard` 3 条 + `datasets-render-parity` 1 条（全死 `pw-local.ts:109` `waitUntil`）；跑 2 = parity「查看版本」1 条（30s 未渲染版本行）+ keyboard 整档 3 条 skip（`findFixture()` 2s/3s discovery 被击穿——`HANDOFF.md` §2.6 已知脆弱点）。单文件复跑 exit 0 但 keyboard 整档 skip、parity 3 skip——**skip ≠ 通过，不冒充绿**。
- **档 2（有服务无数据）：未单独跑。沿用 `docs/Spec/M1-验收记录.md` §13.1 档 A 的种子态读数（474 passed / 4 skipped，共 478）。不重复跑的原因：清空 dev 库现有 9 条 run（含 `HANDOFF.md` §2.7 演示 run）属销毁性操作，M3 门禁不依赖该档。**（2026-11-15 需求方裁定）
- **档 1（无服务）未跑**：需停掉在跑真栈（进程归属不明，未授权不杀）。**跳过的档不冒充已跑。**

---

## 1. 前置裁定（§1.1–1.6 六件待拍板 + §1.7 沿承已定 + §1.8 沿承未验证项）

> 依 `docs/HANDOFF.md` §5.5：§1.1–1.6 在 M1/M2 未裁定过。**需求方已于 2026-11-14 逐条裁定**，
> 结论 + 理由 + 边界一并回填于各节；§1.7 为沿承已定，§1.8 为沿承未验证项的处置裁定。

### 1.1 T-5 是否升级为 P1 必修（若要支持 1024 视口）

**背景**：`SPEC-M2` §1.4 已裁定 M2 支持视口 **≥1440**，T-5（窄视口下表格把文档撑宽）记为
**已知缺陷、不修**，并载明升级条件：若将来要求支持 1024，则升 **P1 必修**，修法是给滚动容器
加 `max-w-full` 或给 `<table>` 加 `min-w-0`/`w-max`，修完必须**三页一起复核**并补 1024 文档级断言。
M3 新增的 `PG-08` 与 `PG-04` 双栏都含表格 / 双栏布局，断言档位须与裁定一致。

**待裁定**：M3 是否支持 1024 视口（即 T-5 是否升 P1 必修）。

**影响面**：浏览器用例的几何断言档位（1440 vs 1024）；`PG-08` / `PG-04` 的断言写法。

**裁定（2026-11-14，需求方）**：**断言口径维持 ≥1440，不扩大；T-5 的根因修复在 M3 顺手做**。
状态由「已知缺陷，不修」改为「**已修复（根因），断言口径仍为 ≥1440**」。

- **理由**：区分两件事——断言面不扩大（M3 新页面**不新增 1024 断言**）；但 `DataTable` 的
  `overflow-x-auto` 不阻止 `<table>` 撑宽文档是**单点问题**，修一次所有页面受益。
- **修法与落点**：给滚动容器加 `max-w-full`，落在 **Batch 3**（交付物 6）；修完后 1024 也能过，
  但**不强制断言 1024**；修完复核 `/runs`、`/datasets`、`/targets` 三页 1440 档读数不回退。
- **口径联动**：`SPEC-M2` §1.4 的「已知缺陷、不修」被本裁定**取代**；「1024 只断言不折行」的
  既有边界不变。

### 1.2 `HANDOFF.md` §4.6 的 8 处可判定固定等待是否在本里程碑清理

**背景**：`HANDOFF.md` §4.6 实查 12 处 `waitForTimeout`，其中 **8 处可判定但未替换**
（`datasets-render-parity:487`；`run-detail-keyboard` 的 `:155/:162/:222/:232/:287/:298/:310`，
`sheetTitle()` 即现成探针），另 4 处「等水合」分类正确。同文件 §4.6 建议开 M3 清理批次。
另：`tests/run-detail-keyboard.spec.ts` 的 `findFixture()` 用固定超时（`AbortSignal.timeout(2000/3000)`）
不走 `waitUntil()`，是 M2 第一次读数 6 条 skip 的**最可能来源之一**（`HANDOFF.md` §2.6）。

**待裁定**：是否在本里程碑开独立清理批次（建议并入 Batch 4 或单列）；若不清理，
§6.4 须保持「未替换」口径，不得改写。

**影响面**：§2 批次编排；「跳过 ≠ 通过」读数的稳定性。

**裁定（2026-11-14，需求方）**：**并入 Batch 4，但做成独立提交**；Batch 1–3 期间**不动**。

- 独立一笔 commit，message 原文：**`test(M3): 替换固定等待为条件等待`**；不与真栈联调收尾合笔；
- **清理后连跑 3 次全量 `npm test`，3 次全绿才算完成；跑 1 次绿不算**——理由：清理
  `waitForTimeout` 会引入「基于条件的等待」，后者写不对会成为新的 flaky 来源，3 连跑是最低验证；
- 8 处清单与现成探针（`sheetTitle()` 等）见 `HANDOFF.md` §4.6。

### 1.3 U-1 的关闭条件什么时候执行

**背景**：U-1 固定口径（**每次被问必须原样回答**，`HANDOFF.md` §4.1）：

> 「H-11 的 `taskkill` 子孙清理分支未覆盖。本机 SIGKILL 生效，taskkill 分支被安全分类器拒绝。
> 该分支的清理效果需在 CI 或另一台 Windows 机器确认。」

关闭条件（`SPEC-M2` §1.1）：在 CI 或另一台 Windows 机器跑通
`npx vitest run tests/heartbeat-worker.spec.ts -t "心跳停止后另一 worker 可回收"`，
要求 `statusAfterKill=RUNNING`、`reclaimLines≥1`、`resultRows=2`、`perCase ∈ [1,2]`，
并确认 `taskkill /T /F` 分支真的执行；**若 CI 是 Linux**，`killTree` 走 `child.kill(signal)`，
与 Windows 语义不同，需单独确认。本机至今无 CI。

**待裁定**：CI 是否就位；关闭条件何时执行；是否列入 M3。

**影响面**：§6.4 未验证范围的起始口径；M4 安全加固前的风险敞口。

**裁定（2026-11-14，需求方）**：**CI 就位前保持挂起；每次合并说明必须原样保留 caveat**。

- **关闭条件写死**：CI 跑通 H-11（读数要求同 `SPEC-M2` §1.1）**且 `taskkill` 的子孙清理分支
  被执行**（不只是 SIGKILL 生效）；
- 在关闭之前，**M3 的合并说明必须包含「U-1 未验证，待 CI 确认」**——不能因为
  「已经挂了两个里程碑」就省略；
- 固定口径原文（每次被问必须原样回答）不变（`HANDOFF.md` §4.1）。

### 1.4 `feat/m2-gateway-sse` 与本地 `main` 是否推送远端

**背景**（2026-11-14 实测）：本地 `main` = `5277fd5`，领先 `origin/main`（`dc04385`）
**7 个提交**，这 7 个提交目前**仅存在于本机**；`origin` 上只有 `refs/heads/main`；
`feat/m2-gateway-sse`（`afe07c6`）本地存在、未推送；`v0.1.0-m1` 已推远端。
M2 的先例：`SPEC-M2` §0 检查 1 曾把「上一里程碑已推送 remote」作为编码准入
（`git ls-remote origin main` 复验后才启动 Batch 1）。

**待裁定**：是否推送；推什么（仅 `main`？是否含 `feat/m2-gateway-sse`？）。
**推送属外发动作，本项裁定即授权依据**（`AGENTS.md` §二 第 8 条）。

**影响面**：M3 编码准入是否沿用「先远端备份再开工」先例；灾难恢复面。

**裁定（2026-11-14，需求方）**：**推**。`main` 领先 `origin/main` 的 7 个 M2 提交推送至
`origin/main`（七个提交只在本机是单点故障，推送到远端是必要的备份）。

**已执行（2026-11-14）**，读数：

- 推送前核验：`git ls-remote origin main` → `dc04385`（无分叉）；
  `git rev-list --count origin/main..HEAD` → **7**；`git log --oneline origin/main..HEAD` 逐条
  全为 M2（`1f47b8f` docs → `bdf7c93` contracts → Batch 1–4 → `5277fd5` merge），**无 M3 混入**
  （M3 的 `SPEC-M3.md` 当时未提交，正好）；
- `git push origin main v0.1.0-m2`：`dc04385..5277fd5 main -> main`；推送后
  `git rev-list --count origin/main..HEAD` → **0**。

**边界**：本裁定覆盖 `main` 的 7 个提交；`feat/m2-gateway-sse` 的**分支引用**不在授权范围内、
不推（其提交 `afe07c6` 作为 `5277fd5` 的父提交已随 `main` 入远端，内容不会丢失）。

### 1.5 是否打 `v0.1.0-m2` 标签

**背景**：现有唯一标签 `v0.1.0-m1`（annotated `64bbe2a` → `dc04385`，已推远端）。
M2 合并提交 `5277fd5` 无标签。

**待裁定**：是否打 `v0.1.0-m2`（对象应为 `5277fd5`；是否随 §1.4 一并推远端）。

**影响面**：M3 的基线表述方式与回滚锚点。

**裁定（2026-11-14，需求方）**：**打**。`v0.1.0-m2`（annotated）打在 `5277fd5`，随 §1.4 一并推远端。

- tag message 原文：**「M2 里程碑：多模型网关与 LLM-as-a-Judge」**；
- 理由：tag 是里程碑的锚点，不打 tag 的里程碑等于「完成了但没有标记」；
- **已执行（2026-11-14）**：tag 对象 `0cb34de` → `5277fd5`，`git ls-remote origin v0.1.0-m2` 确认在远端。

### 1.6 `technical-solution.md` §5.1 如何入库；两处计数矛盾是否一并修正

**背景**（`HANDOFF.md` §4.8）：

- **(A) 镜像不一致 1 处**：`docs/facts/technical-solution.md` 的 §5.1「复核记录
  （2026-11-13 · M2 Batch 2）」**只存在于未跟踪的外层副本**，`src/docs/` 副本与 git HEAD 均无
  —— 该内容随时可能丢失。
- **(B) 同文档数字自相矛盾 2 处**：`milestones.md` :15 与 §2.3 仍写「15 表 / 17 触发器」
  （实际 16 表 / 19 触发器）；`database-schema.md` :9 写「16 张」而 :12 同段留「合计 15 张」。

`HANDOFF.md` §4.8 的处置建议：① §5.1 补进 `src/docs/` 副本并**单独提交**（`docs(M2): …`）；
② (B) 按 `docs/工程规则.md` §10「保留原判定 + 追加复核行」处理，不直接替换历史表述；
③ 同步后**两份副本必须一致**。

**待裁定**：是否按上述建议执行；归属哪一笔提交（M3 前置文档笔 / 随 M3 文档笔）。

**影响面**：文档口径单一性；下次交接的读数一致性。

**裁定（2026-11-14，需求方）**：**先列矛盾清单，需求方确认改法后再动手**——不直接按
`HANDOFF.md` §4.8 三步走。本节状态是「**待列矛盾清单**」，**不是**「已按 HANDOFF 处理」。
（**该状态已于 2026-11-15 结束**：改法已确认并执行，见下方「处置」。）

**首轮清单（2026-11-14 实核，待确认）**：

| # | 位置 | 现状原文（摘） | 实际（可复验） |
|---|---|---|---|
| 1 | `milestones.md` :15（引用表，现行事实索引） | 「`database-schema.md`（**15 表、17 触发器**、`T-01`…`T-22`）」 | **16 表 / 19 触发器**（`contracts/src/db-schema.ts` 的 `TABLE_NAMES` / `TRIGGER_NAMES`；复验方式见 `HANDOFF.md` §2.1） |
| 2 | `database-schema.md` :9 vs :12（同段两数字并存） | :9 「13 张业务表 + 1 张门禁执行留痕表 + 1 张人工标注留痕表 + 1 张网关幂等账本 = **16 张**」（2026-11-12 增补后正确）；:12 括号「…合计 **15 张**。**以本文件为准。**」（M1 末尾历史口径，未同步） | 实际 **16 张**；同段「16 张」与「合计 15 张。以本文件为准」并存，读者会取错 |

**差异来源（15/17 → 16/19 的精确构成，git 实证）**：

- **M1 合并（`dc04385`）时点**：迁移 `0001`–`0018` 共 18 个，**15 张表 / 17 个触发器**——`SPEC-M1.md`（:32–:33、:62–:63、:994）与 `M1-验收记录.md` 写 15/17 在当时**是正确的**，属历史快照，不是错误。
- **M2 Batch 1（`982fa1a`）恰好新增一个迁移文件** `0019_claim_epoch.sql`（`git show 982fa1a --stat` 实证，动 `db/` 的仅此一件）：
  - 新增第 16 张表 **`gateway_idempotency`**（幂等账本，M2-1）；
  - 新增 2 个触发器（`0019` 内 :157 / :183 创建，`db-schema.ts` `TRIGGER_NAMES` :162 注释「M2-1（0019）」）：**`trg_gateway_idempotency_no_delete`**（账本不可删）+ **`trg_gateway_idempotency_usage_once`**（用量只允许「占位 → 回填」一次）。
- 因此 **15/17 → 16/19 = M2 Batch 1 的 +1 表 +2 触发器，其余计数全部不变**。
- 两处矛盾的性质：都是「现行索引没跟上 M2 增量」，不是谁写错了历史——`milestones.md` §2.3 与 `SPEC-M1.md` 的 15/17 是 M1 范围的历史描述（保留不动）；`database-schema.md` 自身变更记录（:1071–:1075）已完整记载 15→16、17→19，只有 :12 的括号尾巴没同步。

**§5.1 一致性核对（入库前核对，2026-11-14 实核）**：

| §5.1 的声称 | 实核结果 |
|---|---|
| `tools/litellm/config.example.yaml` 与生成器是键名唯一去处 | ✅ 路径存在（`tools/litellm/config.example.yaml`），`tests/litellm-sidecar.spec.ts:257–265` 确实读取比对 |
| `tests/gateway-target.spec.ts` 钉住「不配直连、配了改投」 | ✅ `:85`（未配置 ⇒ 直连，M1 行为不变）与 `:125`（配置 ⇒ 改走 sidecar）与声称一致 |
| 「两条实现约束**写进 `lib/gateway/litellm-config.ts` 的头注释**」 | ✗ **位置不符**：`litellm-config.ts` 头注释的「两条不能违反的边界」是另外两条（Key 只以 `os.environ/<变量名>` 出现、不写计费字段）；§5.1 约束①（缺省直连）实际落在 `lib/gateway/target.ts` 头注释（「默认行为必须与 M1 完全一致（没配 `LITELLM_BASE_URL` 就直连）」）；约束②（键名同构 / 计费键判红）落在生成器红线 + 单测 |
| 「真栈联调属 Batch 4，届时以实际启动结果为准」 | ⚠ **预期未兑现**：Batch 4 实跑时 gateway profile 未拉起，容器至今未启动（`SPEC-M2` §6.4 / `HANDOFF.md` §4.5）——需追加复核行与「未验证」口径对齐，不构成内容错误 |

**处置（2026-11-15 需求方裁定「保留原判定 + 追加复核行」，已执行）**：① 两处计数矛盾各追加一条
复核行（`milestones.md` :15 后、`database-schema.md` :12 后，均注明 M2 `0019` 增量 +1 表
`gateway_idempotency` +2 触发器；追加后 `grep` / `git diff --numstat` 核对通过：**只增不改，每文件 +2/−0**）；
② `technical-solution.md` §5.1 三处修正（约束①归属 `target.ts`、约束②「生成器红线 + 单测」、
追加「Batch 4 未拉起 gateway profile，容器未启动…」复核行）已执行，入库随
`docs(M2): technical-solution §5.1 入库与归属修正` 一笔。

### 1.7 契约扩展流程（已定，沿承，不重议）

**结论（2026-11-12 裁定，`HANDOFF.md` §5.4 原样）**：**先扩契约、单独提交锁定，再写业务代码**。

流程（M3 全程遵守，前缀改 `contracts(M3):`）：

1. 在任务分支上**只改 `src/contracts/`**（新增 schema / 字段 / `WRITE_ONLY_FIELDS` 条目）；
2. 跑 `npm run typecheck`（含契约 workspace）与 `npm run lint`；
3. **单独一笔 commit**，message 前缀 `contracts(M3):`，正文列出新增/变更的 schema 名与理由；
4. 该 commit 之后，后续批次**只读契约**，不得再改；
5. 中途发现契约缺口 → **停下**、另开一笔 `contracts(M3):` 提交，**不得与业务代码混在同一笔**。

> 已发生的历史违反：M2 Batch 1（`982fa1a`）曾把契约登记改动与业务代码混在一笔
> （`HANDOFF.md` §4.7 第 1 条，`ACCEPT with caveat`）。M3 不得重演。
>
> **M3 现状**：§0 检查 6 已实核所需契约**全部存在**，预期**零扩展起步**；
> 上列第 5 步是唯一的扩展通道。

### 1.8 M2 沿承未验证项的补验处置

**背景**：M2 §6.4 / `HANDOFF.md` §4.5 的未验证项中，前三项被 `HANDOFF.md` §6.3 第 4 条点名
「M3 规格应显式说明是否在本里程碑补验」：

| 项 | 未验证内容（索引） |
|---|---|
| 真实厂商网关未接入 | 限流、超时、非 200 响应、流式差异；分时计费未与真实账单对账 |
| LiteLLM sidecar 未起真容器 | 真实路由转发与并发限流仅有配置产物断言 |
| 浏览器层 `EventSource` 未覆盖 | SSE 覆盖为 route 直调 + 状态机单测 + 真栈 curl 三层，无真实浏览器用例 |

另有 `e2e-fail.ts` 未按原样运行（前置状态「fixture 进程真的不在」未覆盖）与 U-1（§1.3）。
`milestones.md` §4.2 的 M3 范围**不含**其中任何一项 —— 补验属**范围新增**，须裁定。

**待裁定**：三项（+ e2e-fail）是否在 M3 补验：全部 / 部分（指定）/ 都不
（顺延 M4，保持「未验证」口径，不得改写为已验证）。

**影响面**：§2 是否追加批次；§6.4 的初始行。

**裁定（2026-11-14，需求方）**：**顺延 M4，保持「未验证」口径；M2 三项未验证，顺延 M4，M3 不依赖**。

**依赖性核验（裁定的前置条件，2026-11-14 完成）**——M3 范围逐项与三项对查：

| M3 范围项 | 是否依赖三项 |
|---|---|
| compare / diff API | 否——只读已落库的**终态**结果，fixture run 即可产生可比数据，与网关形态无关 |
| `PG-08` / `PG-04` 双栏 | 否——纯消费落库数据 |
| `PG-03` 筛选（`US-010`） | 否——走 `GET /api/runs/[runId]/cases`（HTTP 列表查询，`EvalCaseResultListQuery`），**不经 SSE** |
| 提名 / 确认 / `PG-09` Tab | 否——HTTP 写读 |

SSE 断线续传相关项（浏览器 `EventSource` 未覆盖）针对的是 M2 已交付的 `PG-03` 实时进度面；
M3 **不新增、不修改任何 SSE 事件与流式路径**（§3 硬约束），故不构成依赖。
LiteLLM 真容器与真实厂商两项同样不被 compare / baseline 任何路径引用。

**边界**：

- 三项在 M3 §6.4 **保持「未验证」口径**，不得改写为已验证；
- **M4 起草义务（本裁定的一部分，不得遗失）**：在 M4 的 SPEC 里，这三项必须列为
  **M4 的准入条件之一**（「M2 未验证项已补验」），不得无限顺延；
- `e2e-fail.ts` 未按原样运行属同类沿承未验证项，随本口径一并顺延 M4（需求方裁定针对三项，
  此项随行）；U-1 的处置独立走 §1.3，不在本条范围。

---

## 2. 批次编排

> **串行主线 + 局部并行**。每批结束提交一次，不合成大 commit（§1.7 / `AGENTS.md` §七）。
> Batch 5 独立验收复核**不在开发批次内**，但必须做。
>
> **准入闸门（2026-11-14 更新）**：§1.1–1.6、§1.8 已全部裁定（§1.6 为「先列清单、确认后改」，
> 不阻塞编码）；**§0 检查 5 门禁基线复跑留读数之前，任何批次不得开工**。
>
> 范围来源：`milestones.md` §4.2 全量六条，未增未减；归属故事 `US-009` `US-010` `US-011`(双栏)
> `US-013` `US-020`（`milestones.md` §1 M3 行）。

### Batch 1 · Baseline 提名 / 确认链路（串行先行）

**包含任务**

- `[BE-M3-01]` Baseline API（提名 / 决定 / 解析）

**准入条件**：§0 全部通过（含检查 5 门禁基线复跑留读数）。§1 裁定已于 2026-11-14 齐备。

**交付物**

1. `POST /api/baselines`（提名，入参 `BaselineNominate`）·
   `POST /api/baselines/{baselineId}/decision`（确认 / 驳回，入参 `BaselineDecision`）·
   `GET /api/baselines/resolution`（按评测集解析当前基线）——契约已锁定（`openapi.yaml:651–727`），按契约实现
2. **权限铁律落地**（`BL-1` / `BL-3`，`gate.ts` 文件头）：`ROLE-A` 只能提名；
   确认 / 驳回仅 `ROLE-B`；契约已把「提名」与「决定」拆成两个形状，
   路由层同样按会话上下文校验角色，让越权调用类型上写不出来、运行层也进不来
3. `ux_baselines_one_confirmed`（`0012` 部分唯一索引）语义复用：第二次 `CONFIRMED` 插入被拒
   （`T-07` 仍绿，`milestones.md` §4.5 第 5 条）；`trg_baselines_guard` 不可变触发器不受影响
4. 单测：提名 → 确认链路；第二次 `CONFIRMED` 被拒；驳回留痕；越权路径被拒

**预期无新迁移**。若实现确需迁移：续号 `0020+`，`down/` 配套，
`db/schema/` 与 `docs/facts/database-schema.md` 同步；**若涉及契约**则按 §1.7 第 5 步停下另开 `contracts(M3):`。

**准出条件（缺一不可）**

- [ ] 上述单测 **100% 绿灯**
- [ ] `npm run typecheck` && `npm run lint:design` && `npm test` 退出码 0
- [ ] **本批次结束时提交一次**，commit message 写清范围
- [ ] 门禁读数写明**环境条件**（种子态 / 有数据态）

---

### Batch 2 · 对比引擎（`GET /api/compare` 与 `GET /api/compare/diff`）

**包含任务**

- `[BE-M3-02]` 汇总对比 + 逐条 Diff 引擎

**准入条件**：Batch 1 全部准出通过。

**交付物**

1. `GET /api/compare`：`CompareQuery`（`baselineRunId` / `currentRunId` /
   `regressionThreshold` 默认 0）→ `CompareResponse`（双 Run 概要 + `metrics` + `cases` + 分页 +
   `baselineConfirmed` + `banner`）
2. `GET /api/compare/diff`：`RunComparisonDiffResponse` —— 算子级 Δ + 逐条 Δ + `summary` +
   `alignmentWarning`（契约已锁定 `eval-contracts.ts:352`，实现层扩展而非另写一份）
3. **对齐硬拒绝**（`milestones.md` §4.3）：两个 Run 的 `dataset_version_id` 不同 →
   `describeIncomparable()` 直接拒绝，**不出表**；同 run 自比 → 拒绝
4. **缺一侧不得渲染 0**：任一侧 `score IS NULL` → `NOT_COMPARABLE`，
   前端渲染「不可比」（判定函数已在契约层，实现复用）
5. 单测：逐条 Δ 与算子级 Δ **可手工复算**（抽查口径）；跨版本硬拒绝；
   `NOT_COMPARABLE` 路径；`regressionThreshold` 边界

**准出条件（缺一不可）**

- [ ] 上述单测 **100% 绿灯**
- [ ] `npm run typecheck` && `npm run lint:design` && `npm test` 退出码 0
- [ ] **本批次结束时提交一次**
- [ ] 门禁读数写明环境条件

---

### Batch 3 · 前端工作台（`PG-08` / `PG-04` 双栏 / `PG-03` 筛选 / 提名与确认入口）

**包含任务**

- `[FE-M3-01]` `PG-08` 对比工作台页
- `[FE-M3-02]` `PG-04` 升级 `CaseDiffSheet` 双栏
- `[FE-M3-03]` `PG-03` 筛选启用 + `PG-01` / `PG-03` 提名入口 + `PG-09` 基线确认 Tab

**并行建议**：所需契约**全部已锁定**，`[FE-M3-01]`/`[FE-M3-02]` 的 UI 骨架可与 Batch 1 并行启动；
**数据联调须等 Batch 2 绿灯**。

**交付物**

1. `PG-08`：选择器 + 汇总对比表（`MetricDeltaBadge`）+ 逐条对比表 +
   **未确认基线横幅**（`baselineConfirmed=false` 时必须显示，`BL-2`）。
   页面路由与区块划分以 `docs/facts/pages-and-flows.md` 的 `PG-08` 定义为准
2. `PG-04` → `CaseDiffSheet` 双栏：`diff.add` / `diff.del` 高亮、`+`/`−` 前缀、
   `J`/`K` 键盘、Tabs（并排 / 行内）；**`J`/`K` 在 `input` / `textarea` / `select` /
   `contenteditable` 内不生效**（`milestones.md` §4.5 第 4 条）；保留 T-6 的
   「上一条 / 下一条」按钮（`title` 标注快捷键，单条 Case 时不渲染）
3. `PG-03` 工具栏启用筛选（`US-010`）：`minScore` / `maxScore` / `status` /
   `evaluatorKey` / `regressedOnly` —— 契约字段已存在（P0 期恒 undefined，本批启用）
4. `PG-01` / `PG-03` 的「提名基线」入口（`US-013`，`ROLE-A`）
5. `PG-09` 增「基线确认」Tab（`US-020`，`ROLE-B`：确认 / 驳回 + 理由）
6. **T-5 根因修复**（裁定 §1.1）：`DataTable` 滚动容器加 `max-w-full`；修完复核
   `/runs`、`/datasets`、`/targets` 三页 1440 档读数不回退；**不新增 1024 断言**

**硬约束**：颜色不是唯一编码 —— 必须有 `+`/`−` 前缀与方向箭头（`DESIGN.md` §8）；
数字排版一律 `tabular-nums`；界面数据只来自接口，禁止写死数组（跨里程碑不妥协项 5）。

**准出条件（缺一不可）**

- [ ] `npm run lint:design` 退出码 0（含 `check:tokens` 无裸色值 / 渐变 / 内联样式）
- [ ] 浏览器用例（真实 Edge）全绿 **0 skipped**；若有 skip，读数写 `N passed / M skipped` 并打印原因
- [ ] `J`/`K` 焦点不生效断言通过；未确认基线横幅断言通过
- [ ] `npm test` 退出码 0；**本批次结束时提交一次**；读数写明环境条件

---

### Batch 4 · 全链路真栈联调与研发自检收尾

**包含任务**

- `[INT-M3-01]` 真栈联调
- **固定等待清理（裁定 §1.2，必做）**：8 处可判定 `waitForTimeout` 替换为条件等待
  （现成探针含 `sheetTitle()`，清单见 `HANDOFF.md` §4.6）；`run-detail-keyboard` 的
  `findFixture()` 固定超时一并替换为 `waitUntil()`。**独立一笔提交**，message 原文
  `test(M3): 替换固定等待为条件等待`，不与真栈联调收尾合笔；
  **清理后连跑 3 次全量 `npm test`，3 次全绿才算完成（跑 1 次绿不算）**

**准入条件**：Batch 1–3 全部完成且**无遗留前端 Mock 数据**。

**准出条件（缺一不可）**

- [ ] 真栈演示链路跑通：两个同版本 Run 对比 → `PG-08` 汇总与逐条 → `PG-04` 双栏 Diff →
      提名 → 确认 → 未确认横幅消失；跨版本对比被拒且原因明确
- [ ] 全量 `typecheck`、`lint:design`、L1 单测、L2 真栈切片**全部通过**
- [ ] `npm run check:datasets-render` 人工门禁通过（**合并前必须跑**，接不进 pre-commit）
- [ ] **本批次结束时提交一次**，这是 M3 的最后一个 commit
- [ ] 固定等待清理的**独立提交笔**已落，3 连跑全绿读数**留档**（裁定 §1.2）
- [ ] **合并说明包含「U-1 未验证，待 CI 确认」原句**（裁定 §1.3，不得省略）
- [ ] 研发自检记录追加写入本文件 §6，写明固定 Commit Hash 与门禁读数的环境条件

---

### Batch 5 · 独立验收复核（不在开发批次内，但必须做）

**执行方式**：Batch 4 完成后，**开一个全新上下文的会话**做复核，**不复用开发会话**。

**复核范围（至少覆盖）**

- [ ] `milestones.md` §4.5 五条完成判定**逐条实跑复现**（不是开发 Agent 的自述）
- [ ] 逐条 Δ 与算子级 Δ **手工复算一致（抽查 5 条）**
- [ ] 第二次 `CONFIRMED` 插入被拒（`T-07` 仍绿）；`UX-BL-01`（一集一确认基线）UI 侧表达正确
- [ ] 契约纪律：预期零扩展；若发生过扩展，`contracts(M3):` 是否独立成笔、后续是否只读
- [ ] §1 各项裁定是否落档执行；`HANDOFF.md` §4.5 未验证项是否未被冒充为「已验证」
- [ ] 门禁读数的环境条件是否写明；跳过的断言是否打印原因且不计入通过数
- [ ] §1.2 的独立提交笔与 3 连跑全绿读数；T-5 根因修复后三页 1440 复核读数（§1.1）
- [ ] M3 合并说明是否含「U-1 未验证，待 CI 确认」原句（§1.3）

**复核结论**：`ACCEPT` / `ACCEPT with caveat` / `REJECT`。`REJECT` 则回到对应 Batch 修复。

---

## 3. 不做什么（硬约束）

- **六件未裁定不进 Batch 1 编码**（`HANDOFF.md` §6.5）
- **不做 Badcase 回流**（`US-012` 为 P2、`PF-2` 不建页面，2026-11-07 拍板，全部里程碑不做；
  `case_human_labels` 表仅作为数据库层扩展性存在）
- **不重构执行层**：worker + `claim_next_run()` + `claim_epoch` + 幂等账本 + 状态机
  全部不触碰（M1/M2 已定型）
- **不做事件回放**：`PROGRESS_RESUME_POLICY.mode = 'snapshot_only'` **不得修改**
  （需求方 2026-11-07 拍板）；`PG-08` / `PG-04` 只消费已落库的终态结果，不新增 SSE 事件类型
- **不采信上游成本**（`TS-2` 红线：所有金额只由 `model_prices` 计算）
- **不出现任何 API Key 明文**（`WRITE_ONLY_FIELDS` 只写不读）
- **跨版本对齐硬拒绝**，不出降级对比表；**缺一侧不渲染 0**（`NOT_COMPARABLE`）
- **颜色不是唯一编码**（`DESIGN.md` §8：`+`/`−` 前缀 + 方向箭头）
- **单条 Case 重试不做**（`pages-and-flows.md` §7 拒绝清单）
- **不直接改 `main`**；合并 / 推送远端需需求方**明确授权**（`AGENTS.md` §二 第 4、8 条）
- **不把多个批次合成一个大 commit**；**不把「跳过」当「通过」**
- **不承接 M4 范围**（门禁规则配置 / Webhook 推送 / 成本台账 / 算子模板 / T2 Target
  —— `milestones.md` §5，M3 不得顺手做）

---

## 4. 与 M2 的衔接

| 项 | M2 状态（可复验） | M3 动作 |
|---|---|---|
| worker / `claim_epoch` / 幂等账本 | `5277fd5` 已定型，704 passed / 0 skipped | **不触碰** |
| SSE（`snapshot_only`） | 真栈验证：重连只回 1 帧 `snapshot` | 不改；对比工作台只读终态结果 |
| `baselines` 表 + `trg_baselines_guard` + `ux_baselines_one_confirmed` | `0012` 已建，`T-07` 绿 | API + UI 兑现（`US-013` / `US-020`），库层不动 |
| compare / baselines 契约 | 已锁定、**未实现**（20 路由不含） | 按 §2 Batch 1–2 兑现 |
| `EvalCaseResultListQuery` 筛选字段 | 契约已有，P0 期恒 undefined | `PG-03` 启用（`US-010`） |
| `PG-04` 单栏 + 上一条 / 下一条（T-6） | 已交付 | 升级双栏，保留 `J`/`K` 与按钮 |
| `PG-09` | 仅「模型网关」Tab | 增「基线确认」Tab |
| fixture provider | `is_active=false`，默认链路已摘除 | 保持；演示数据用真栈 Run 生成 |
| 门禁基线 | `HANDOFF.md` §2.6 读数 | M3 各批读数**不得低于该口径**；§0 检查 5 先复跑 |

---

## 5. 与原始编排的差异（须记录，不得静默）

> 本文件是 M3 的**首次任务分解**，基线即 `milestones.md` §4，暂无差异行。
> 执行中出现的任何编排差异**逐行追加于此**，不得静默。
> 若 §1.8 裁定为补验，追加的批次与理由在此登记；若 §1.2 裁定清理，
> Batch 4 的范围变化在此登记。

| 项 | 原始编排 | 实际裁定 | 理由 |
|---|---|---|---|
| T-5 | `SPEC-M2` §1.4：已知缺陷、不修（若升 P1 须三页复核 + 1024 断言） | **根因修复顺手做**（Batch 3，滚动容器 `max-w-full`），断言口径仍 ≥1440，**不新增 1024 断言** | 需求方 2026-11-14：单点根因修一次全站受益；断言面不扩大（§1.1） |
| 8 处固定等待 | `HANDOFF.md` §4.6 建议「M3 开清理批次」，归属未定 | 并入 Batch 4 但**独立提交笔**，**3 连跑全绿**才算完成 | 需求方 2026-11-14：条件等待可能引入新 flaky，独立笔 + 3 连跑兜底（§1.2） |
| M2 三项未验证 | `HANDOFF.md` §6.3 待裁定 | **顺延 M4**，M3 不依赖（依赖性核验见 §1.8）；M4 SPEC 必须列为准入条件 | 需求方 2026-11-14（§1.8） |
| 推送 / tag | `HANDOFF.md` §5.5 第 4、5 条待裁定 | `main` 7 提交已推远端；`v0.1.0-m2` 已打在 `5277fd5` 并推远端 | 需求方 2026-11-14：单点故障必须备份；tag 是里程碑锚点（§1.4 / §1.5） |

---

## 6. 【研发自检记录】（Batch 4 完成后填写）

> 本节由研发侧在 M3 最后一个 commit 前填写，对应 §2 Batch 4 准出条件。
> **「已通过」只对实跑过的检查项成立**；未跑的项目必须显式列为「未验证」。
> 当前为**空模板**。

### 6.1 提交信息

（待填：分支 / 基线 / 提交 / 合并状态。固定 Commit Hash 的自引用问题与处置方式照抄 `SPEC-M2` §6.1 —— 写可机械复验的定位方式，不写会过期的字面量。）

### 6.2 批次完成情况

（待填：Batch 1–4 状态 / 主要交付物 / Commit。）

### 6.3 机械门禁实测

（待填：每条读数必须写明**环境条件**（种子态 / 有数据态 / 有 worker 态 / dev server 态）；
`npm test` 必须写 **N passed / M skipped**，跳过 ≠ 通过。）

### 6.4 未验证范围（如实列出，不写「应该没问题」）

（初始沿承行，处置已按 §1.2 / §1.3 / §1.8 的 2026-11-14 裁定回填；各项在兑现前**保持「未验证」口径**）：

| 项 | 来源 | M3 处置 |
|---|---|---|
| U-1（`taskkill` 子孙清理分支） | M1 沿承 | **挂起**；M3 合并说明必含「U-1 未验证，待 CI 确认」；关闭条件写死见 §1.3 |
| 真实厂商网关未接入 | M2 §6.4 沿承 | **顺延 M4**（M4 SPEC 准入条件）；M3 不依赖（§1.8） |
| LiteLLM sidecar 未起真容器 | M2 §6.4 沿承 | **顺延 M4**（M4 SPEC 准入条件）；M3 不依赖（§1.8） |
| 浏览器层 `EventSource` 未覆盖 | M2 §6.4 沿承 | **顺延 M4**（M4 SPEC 准入条件）；M3 不依赖、不改 SSE 路径（§1.8） |
| `e2e-fail.ts` 未按原样运行 | M2 §6.4 沿承 | 随 §1.8 口径顺延 M4 |
| 8 处可判定固定等待未替换 | `HANDOFF.md` §4.6 | **Batch 4 清理**（独立笔 `test(M3): 替换固定等待为条件等待` + 3 连跑全绿，§1.2）；完成后本行移除并留读数 |
