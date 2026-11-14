# HANDOFF · 评测中台接手交接包

> **本文件的唯一用途**：让接手的 AI 工具（Zed / zcode / Claude Code / Codex）在不读聊天记录的前提下，
> 靠**可寻址的路径与可复验的命令**恢复上下文。
>
> **不写散文，只写事实。** 每个数字都能用同节给出的命令复验；复验不出来即为本文件错误。
>
> 生成时间：2026-11-14 · 生成者：Claude Code（M2 收尾会话）
> **约束**：本文件不修改任何 M1/M2 已合并的 commit 或 tag，也不代表对 M3 范围拍板。

---

## 1. 任务与状态

| 项 | 值 |
|---|---|
| 项目 | 企业级 AI 评测中台（Evaluation Middle Platform） |
| 项目根目录（AI 约定入口所在） | `D:\Evaluation Middle Platform`（`AGENTS.md` / `CLAUDE.md` / `README.md` / `docs/` 在此） |
| **源码根目录（git root）** | **`D:\Evaluation Middle Platform\src`** —— 独立 Git 仓库，`git rev-parse --show-toplevel` 返回它 |
| remote origin | `https://github.com/qingfeng092802/Evaluation-Middle-Platform.git` |
| M1 固定提交 | `dc04385` `merge(M1): 确定性评测闭环首个里程碑（--no-ff）` |
| M1 标签 | `v0.1.0-m1`（**annotated tag**，tag 对象 `64bbe2a9e07c4888b0b9631a0ee4b5d688227e46` → 指向 `dc04385`）；**已推远端**，用 `git ls-remote --tags origin` 复验 |
| **当前阶段** | **M2 已开发完成并已合并入本地 `main`**；**M3 未启动** |
| `main` HEAD | `5277fd5` `merge(M2): 多模型网关、并发跑批与 SSE 续传（--no-ff）` |
| `origin/main` | `dc04385` —— **本地 `main` 领先 7 个提交，尚未推送** |
| 工作区状态 | 干净（`git status --porcelain --untracked-files=all` 输出为空） |

### 1.1 M2 提交链（固定，可逐条 `git show` 校验）

```
dc04385  merge(M1): 确定性评测闭环首个里程碑（--no-ff）        ← M1 基线 / tag v0.1.0-m1
1f47b8f  docs(M2): 定稿 SPEC-M2 并落实 T-1 文档口径
bdf7c93  contracts(M2): 新增 provider probe 契约与 claim_epoch fencing token
982fa1a  feat(M2): Batch 1 数据底座、Fencing Token 与幂等账本（0019）
e224cef  feat(M2): Batch 2 多模型网关与 LLM-as-a-Judge（0020）
7be5351  feat(M2): Batch 3 并发跑批引擎 + SSE 续传
afe07c6  feat(M2): Batch 4 全链路真栈联调与研发自检收尾
5277fd5  merge(M2): …（--no-ff，两个父提交 dc04385 + afe07c6）
```

> `5277fd5` 的合并树与 `afe07c6` 的树**逐字节相同**（`git rev-parse 5277fd5^{tree}` = `0414131…`，
> `afe07c6^{tree}` 同值）⇒ 合并没有任何冲突解决漂移。

> ⚠️ **`feat/m2-gateway-sse` 分支仍在本地、未推送远端**；`origin` 上只有 `refs/heads/main`。

复验命令：

```bash
cd "D:/Evaluation Middle Platform/src"
git rev-parse --short HEAD origin/main          # 5277fd5 / dc04385
git rev-list --count origin/main..HEAD          # 7
git status --porcelain --untracked-files=all    # 空
git cat-file -t v0.1.0-m1                       # tag
git ls-remote --tags origin                     # 含 refs/tags/v0.1.0-m1
git branch -a                                   # 含本地 feat/m2-gateway-sse（无 remotes/origin/feat/*）
```

---

## 2. 已完成（可验证）

### 2.1 数据底座

| 项 | 数量 | 复验方式 |
|---|---|---|
| 业务表 | **16 张**（`contracts/src/db-schema.ts` 的 `TABLE_NAMES`） | `node -e "…TABLE_NAMES…"`；或 DB 内 `information_schema.tables` 得 17 张（16 业务表 + `schema_migrations`） |
| 迁移 | **19 个**（`0001`…`0019`），最后一笔 `0019_claim_epoch.sql`；**没有 `0020`** | `ls db/migrations/*.sql \| wc -l`；`schema_migrations` 表列为 `file` / `applied_at`（**不是** `version`），19 行 |
| 不可变触发器 | **19 个**（`TRIGGER_NAMES` 19 项，与 DB 实测一致） | `SELECT count(*) FROM information_schema.triggers WHERE trigger_schema='public'` |

迁移文件名（`src/db/migrations/`）：
`0001_datasets` · `0002_dataset_versions` · `0003_dataset_cases` · `0004_model_providers` ·
`0005_model_prices` · `0006_targets` · `0007_target_versions` · `0008_evaluators` ·
`0009_eval_runs` · `0010_run_evaluators` · `0011_eval_case_results` · `0012_baselines` ·
`0013_regression_gates` · `0014_gate_evaluations` · `0015_case_human_labels` ·
`0016_immutability_triggers` · `0017_queue_functions` · `0018_heartbeat_lease` ·
`0019_claim_epoch`（含 `down/0019_claim_epoch.down.sql` 回滚）

### 2.2 算子（`contracts/src/evaluator.ts` 的 `BuiltinEvaluatorKey` 是唯一事实源）

**内置确定性算子 6 个，逐字如下：**

| key | 是否需要 retrieval | 实现文件 |
|---|---|---|
| `recall_at_k` | 是 | `lib/operators/recall-at-k.ts` |
| `mrr` | 是 | `lib/operators/mrr.ts` |
| `ndcg_at_k` | 是 | `lib/operators/ndcg-at-k.ts` |
| `json_schema` | 否 | `lib/operators/json-schema.ts` |
| `regex` | 否 | `lib/operators/regex.ts` |
| `numeric_fidelity` | 否 | `lib/operators/numeric-fidelity.ts` |

> **不存在 `ExactMatch` / `exact_match` 算子。** 任何文档或交接材料里出现 `ExactMatch` 都是错的。

另有 **LLM-as-a-Judge** 一类（`lib/operators/judge.ts`），key 形如 `judge.<slug>`，
与内置 key 不冲突。`EvaluatorKind = ['rule','judge']`。
解析失败 = `PARSE_ERROR` 且 `score IS NULL`（**不落 0 分**）。

### 2.3 功能链（每条都有对应实现文件与用例）

| 能力 | 落点 |
|---|---|
| 评测集导入 JSONL / CSV + 校验报告 | `lib/import/{canonical,common,csv,jsonl}.ts`；`POST /api/datasets/imports/validate`；`POST /api/datasets/{id}/imports` |
| 不可变版本快照 | 迁移 `0016_immutability_triggers`；`lib/runner/version.ts` |
| EvalRun 入队 / 前置校验 / 执行 / 汇总 | `lib/runner/{create-run,execute-case,concurrency,prompt,judge-chat}.ts`；`worker/index.ts`；`POST /api/runs`、`GET /api/runs/preflight` |
| 多模型网关 | `lib/gateway/{index,target,litellm-config}.ts`；厂商 Key 用 AES-256-GCM（`db/provider-key-cipher.ts`，缺 `PROVIDER_KEY_SECRET` 即抛错） |
| 幂等账本（M2-1） | 表 `gateway_idempotency`（`0019`），唯一键 `idempotency_key = run_id + case_key` 派生 |
| Fencing token（M2-3） | `eval_runs.claim_epoch bigint NOT NULL DEFAULT 0`；`claim_next_run()` 每次领取 `+1`；worker 全部写入带 `WHERE claim_epoch = $epoch` |
| SSE 实时进度 | `GET /api/runs/{runId}/stream`；`lib/ui/{run-stream-client,use-run-stream}.ts`；帧型 `snapshot/case/status/heartbeat/error`；心跳 15s；`PROGRESS_RESUME_POLICY.mode='snapshot_only'`（**不回放，不加环形缓冲**，需求方 2026-11-07 拍板，**不得修改**） |
| 模型网关配置界面 | `PG-09` 模型网关 Tab = `app/settings/page.tsx` |

### 2.4 页面（9 个 `page.tsx`，全部在 `src/app/`）

`/`（`app/page.tsx`）· `/datasets` · `/evaluators` · `/runs` · `/runs/[runId]` ·
`/runs/compare` · `/runs/new` · `/settings` · `/targets`

> 交接模板里写的「PG-01 / PG-03 / PG-04 / PG-05」是**页面编号**，不是路由数量；
> 实际路由是 9 个，页面编号见 `docs/facts/pages-and-flows.md`（`PG-01`…`PG-10`）。

### 2.5 API（20 个 `route.ts`）

`/api/datasets` · `/api/datasets/[id]` · `/api/datasets/[id]/imports` ·
`/api/datasets/[id]/versions` · `/api/datasets/[id]/versions/[versionNo]` ·
`/api/datasets/imports/validate` · `/api/prices` · `/api/providers` ·
`/api/providers/[providerId]` · `/api/providers/[providerId]/probe` ·
`/api/runs` · `/api/runs/preflight` · `/api/runs/[runId]` · `/api/runs/[runId]/cases` ·
`/api/runs/[runId]/cases/[caseKey]` · `/api/runs/[runId]/stream` · `/api/targets` ·
`/api/targets/[id]` · `/api/targets/[id]/versions` · `/api/targets/versions/[targetVersionId]`

### 2.6 门禁读数（**4 项读数，覆盖 5 条命令**：`lint` 已含在 `lint:design` 里）

**本文件生成时（2026-11-14）在已合并的 `main`（`5277fd5`）上实跑：**

| 门禁 | 命令 | 读数 |
|---|---|---|
| 类型（应用 + 契约 workspace） | `npm run typecheck` | **exit 0** |
| 静态 + 样式 + Token | `npm run lint:design` | **exit 0**；`[check:tokens] 通过：98 个文件，无裸色值 / 渐变 / 内联样式` |
| 跨层渲染对账 | `npm run check:datasets-render` | **exit 0**；`/datasets` `apiItems=6 renderedRows=6 statusCount=6`，`/runs` `apiItems=9 renderedRows=9 statusCount=9` |

**`npm test` 的两次完整实跑（同一 `main`，真栈常驻）：**

| 次 | 读数 | 说明 |
|---|---|---|
| 1 | **53 passed / 1 skipped (54 files)**；**698 passed / 6 skipped (704)**，245.38s | 该次未保留 verbose 明细，**6 条 skip 的逐条归属未取证**。已知具备跳过分支的文件：`tests/run-detail-keyboard.spec.ts`（3 条，`findFixture()` 里 `AbortSignal.timeout(2000/3000)` 固定超时被击穿即整组跳过）、`tests/runs-render-parity.spec.ts`（1 条几何断言，需 `HAS_RUN_ROWS`）。**单独复跑这两个文件均全绿** |
| 2 | **54 passed (54 files)**；**704 passed / 0 skipped**，254.37s（`--reporter=verbose` 全量留档） | 热缓存后同栈重跑 |

> **口径**：**「跳过 ≠ 通过」**。上表第 1 次读数**不算通过**，第 2 次才算。
> 第 1 次的 6 条 skip 未取得逐条归因（只知候选文件与机制），**必须按「未验证」记录**，
> 不得改写成「704/0」，也不得断言它们一定不是产品缺陷。
>
> **一条已定位的脆弱点**：`tests/run-detail-keyboard.spec.ts` 的 `findFixture()` 用
> `AbortSignal.timeout(2000)` / `3000` 做 discovery，**不走** `scripts/pw-local.ts` 的 `waitUntil()`。
> 冷编译下 `/api/runs` 实测 2.13s 即被击穿 ⇒ 打印原因并 `skipIf` 跳过 3 条。
> 这是 M3 可清理的确定性技术债（替换为 `waitUntil` 即可）。

**M1 时期的两档读数（记录在 `docs/Spec/M1-验收记录.md` §13.1，只有两档）：**

| 档 | 读数 | 产生条件 |
|---|---|---|
| A | **474 passed / 4 skipped**（共 478） | 服务在跑 + **种子态**（`eval_runs = 0`）+ 本机有 Edge；2026-11-11 16:50 |
| B | **478 passed / 0 skipped** | 服务在跑 + **库中有已完成的 run** + 同上；2026-11-11 18:33 实测 ✅ |

> **交接模板里写的第三档「470 passed / 8 skipped」在 `M1-验收记录.md` 中不存在**，
> 任何位置都查不到该读数。不要引用它。

**M2 自检记录（`docs/Spec/SPEC-M2.md` §6.3）**：`npm test` 54 files / 704 passed / 0 skipped
（244.62s，另一窗口 214.01s），环境为 Windows 11 · Node v24.18.0 · vitest 2.1.8 ·
`dev:all` 完整真栈常驻 · 有数据态 + 有 worker 态 + dev server 态。

### 2.7 L2 真栈切片（实跑，非 mock；`SPEC-M2` §6.3）

| 切片 | 结果 |
|---|---|
| 正向全链路 | run `94dc8cc4-3e1f-4848-879d-461c9e184c18` → `COMPLETED`，50/50，`score_overall=0.6`，`pass_rate=NULL`（未设阈值不拿 0 冒充），`coverage=1`，成本全 0 |
| 负向（网关不可达） | run `1372425f-76d6-425c-aae8-8319371eca11` → `FAILED`，0 成功 / 50 失败，**`score_overall IS NULL`**（不落 0 分、不编分数） |
| SSE 真帧 | `text/event-stream`；帧型 `{snapshot:1, status:2, case:50}`；`id` 从 `…:0` 到 `…:52` 严格单调无重复 |
| SSE 续传口径 | 带 `Last-Event-ID: …:40` 重连 → **只回 1 帧 `snapshot`**，无事件回放 |
| 浏览器层 | 3 files / 43 passed，0 skipped（真实 Edge：`datasets-render-parity` 23 / `runs-render-parity` 17 / `run-detail-keyboard` 3） |

实测数据库注意：Case 结果表是 **`eval_case_results`**，外键列名是 **`eval_run_id`**（不是 `run_id`）；
运行表是 **`eval_runs`**（不是 `runs`）。写查询前先确认。

---

## 3. 关键文件路径

**全部路径以 `D:\Evaluation Middle Platform\` 为基准；「(untracked)」表示不在 git root 内或未被跟踪。**

### 3.1 协作约定入口

| 路径 | 作用 | 是否入库 |
|---|---|---|
| `AGENTS.md`（项目根，git root **之外**） | AI 协作**唯一入口**：目录布局、阅读顺序、硬性边界、门禁命令、测试库隔离、契约只读规则、提交纪律、常用命令 | ❌ 未跟踪 |
| `CLAUDE.md`（项目根） | **只转发 `AGENTS.md`**，不维护内容 | ❌ 未跟踪 |
| `README.md`（项目根） | 项目定位与文档目录树 | ❌ 未跟踪 |
| **`src/AGENTS.md`** | **仓库内的指针**：若工具以 `src/` 为工作区打开，只有这条路径能通到上一级入口 | ⚠️ **本次新增，尚未提交**（见 §7） |

> **Zed / zcode 的可行性**：Zed 读 `AGENTS.md` 作为项目规则入口。
> 因为真正的 Git 仓库根是 `src/`，**在 `src/` 内再放一份指针是必需的** ——
> 否则以 `src/` 为 workspace 打开时看不到任何约定。
> `CLAUDE.md` 对 Zed 无用（那是 Claude Code 的入口），但保留它不产生歧义：它只是转发到 `AGENTS.md`。

### 3.2 事实源（`docs/facts/`，与 `src/docs/facts/` 互为镜像 —— **当前有 1 处例外，见 §4.8**）

| 路径 | 内容 |
|---|---|
| `docs/facts/product-overview.md` | 产品定位、角色、`OUT-1`…`OUT-5`、`ED-01`…`ED-08`、`BL-1`…`BL-4` |
| `docs/facts/user-stories.md` | `US-001`…`US-021` |
| `docs/facts/pages-and-flows.md` | `PG-01`…`PG-10`、`RS-01`…`RS-06` 状态机、拒绝清单 |
| `docs/facts/technical-solution.md` | `TS-1`…`TS-5`、`OPEN-1`…`OPEN-5`、§0.5 网络前提 |
| `docs/facts/database-schema.md` | **16 张表** DDL（§2.16 `gateway_idempotency`）、**19 触发器**、`T-01`…`T-22` |
| `docs/facts/DESIGN.md` | 视觉唯一事实源：语义 Token、`tabular-nums` 强制令、`AS-1`/`AS-2`/`AS-3` |

### 3.3 任务规格（`docs/Spec/`）

| 路径 | 内容 |
|---|---|
| `docs/Spec/milestones.md` | **M1…M4 划分与边界唯一事实源**（§3 = M2，§4 = M3）。⚠️ :15 引用表与 §2.3 的「15 表 / 17 触发器」是 M1 历史表述，与现行 16 表 / 19 触发器不符 —— 见 §4.8 (B) |
| `docs/Spec/SPEC-M1.md` | M1 范围依据与 8 条 Given/When/Then |
| `docs/Spec/SPEC-M2.md` | M2 范围、§1 六条前置裁定、§2 批次编排、**§6 研发自检记录**、**§6.4 未验证范围** |
| `docs/Spec/M1-验收记录.md` | **§13 = 前端实现批次门禁读数（§13.1 两档 `npm test`，§13.4 D-1/U-1）** |
| `docs/Spec/frontend-design-intent.md` | 前端设计意图 |

### 3.4 工程规则与踩坑

| 路径 | 内容 |
|---|---|
| `docs/工程规则.md` | **工程规则唯一正文**。§2 分支隔离 · §3 契约与 SPEC 先行 · §4 TDD 与门禁（§4.0 构建产物、§4.1 样式、§4.2 测试库隔离）· §5 三层验收 · §6 授权合并 · §8 MCP 调度 · §9 安全约束 |
| `docs/LEARNINGS.md` | 重大工程踩坑 |

### 3.5 契约（`src/contracts/`）

| 路径 | 内容 |
|---|---|
| `contracts/src/db-schema.ts` | `TABLE_NAMES`（16）/ `TRIGGER_NAMES`（19）注册表 |
| `contracts/src/api.ts` | 接口形状；`WRITE_ONLY_FIELDS` 在 **:332** |
| `contracts/src/evaluator.ts` | `BuiltinEvaluatorKey`（6 个）、`EVALUATOR_REQUIRES_RETRIEVAL`、`EvaluatorKind` |
| `contracts/src/eval-contracts.ts` | `EvalProgressEvent`；`PROGRESS_RESUME_POLICY` 在 **:106**（`snapshot_only`，**不得修改**） |
| `contracts/src/sse.ts` | `SSE_EVENT_NAMES`（:107）、`SSE_HEARTBEAT_INTERVAL_MS=15_000`（:117）、`SSE_CLIENT_SILENCE_TIMEOUT_MS=30_000`（:123） |

### 3.6 迁移与门禁脚本

| 路径 | 作用 |
|---|---|
| `src/db/migrations/0001`…`0019` | 19 个迁移；`down/` 下对应回滚 |
| `src/.githooks/pre-commit` | 三道机械门禁：`typecheck` → `lint` → `test`。启用：`npm run hooks:enable`。**仓库内没有 `pre-merge-commit`，`git merge` 不跑门禁** |
| `src/scripts/dev-all.ts` | 真栈监督进程（db → migrate → seed → fixture:8787 → worker → next:3000）。任一子进程非 SIGTERM/SIGINT 退出即整栈失败 |
| `src/scripts/pw-local.ts` | 浏览器用例的驱动封装；`waitUntil(probe, {timeoutMs, message})` 超时**抛错**（不返回 false） |
| `src/scripts/check-datasets-render.ts` | 跨层渲染对账（人工合并门禁，接不进 `pre-commit`） |
| `src/scripts/seed.ts` | 种子（**对 provider 激活状态是破坏性的**，见 §4.6） |

---

## 4. 已知边界

### 4.1 U-1 · `taskkill` 子孙清理分支未覆盖（**口径固定，每次被问必须原样回答**）

> 「H-11 的 `taskkill` 子孙清理分支未覆盖。本机 SIGKILL 生效，taskkill 分支被安全分类器拒绝。
> 该分支的清理效果需在 CI 或另一台 Windows 机器确认。」

- 位置：`tests/heartbeat-worker.spec.ts` 的 `killTree(force)`。M1 收口时改为「先 `child.kill('SIGKILL')`，
  `taskkill /T /F` 降级为子孙清理兜底」。
- **CI 跑通前不得当作「已验证通过」。**
- 关闭条件（`SPEC-M2` §1.1）：CI 或另一台 Windows 机器跑通
  `npx vitest run tests/heartbeat-worker.spec.ts -t "心跳停止后另一 worker 可回收"`，
  要求 `statusAfterKill=RUNNING`、`reclaimLines≥1`、`resultRows=2`、`perCase ∈ [1,2]`，
  并确认 `taskkill /T /F` 分支真的执行。**若 CI 是 Linux**，`killTree` 走 `child.kill(signal)`，
  与 Windows 语义不同，需单独确认，**不得默认「本机绿 = CI 绿」**。
- 另注：U-1 的固定口径**尚未写入** `M1-验收记录.md` §13.4（仍为 M1 时期表述）。
  这是 `SPEC-M2` §1.1 要求的写入位置之一，**未兑现**（见 §5.1 与 §4.7 第 2 条）。

### 4.2 M2-1 · 重复计费 — **已在 M2 处置（Must-have）**

- 原问题（`M1-验收记录.md` §10 M2-1）：at-least-once 语义下 worker 真崩溃时在途 Case 被重跑，
  网关被多调用一次，`cost_target` 与实际账单可能不一致。
- **落地方式**（`SPEC-M2` §1.3）：网关请求带由 `run_id + case_key` 派生的 idempotency key，
  账本落 `gateway_idempotency` 表（`0019`）。**未采用**「接受重复计费 + 报告标注」。
- **剩余边界**：只保证「同一 key 只计费一次」在**我方账本**里成立；
  真实厂商侧是否按 idempotency key 去重**未验证**（真实厂商未接入，见 §4.5）。

### 4.3 M2-3 · 租约无 fencing token — **已在 M2 处置（Must-have）**

- 原问题（`M1-验收记录.md` §10 M2-3）：worker 长期停顿（GC / 宿主挂起）而非死亡时，
  恢复后会续写已被别人领走的 run 的心跳，两个 worker 可能同时在跑同一条 run。
- **落地方式**：`eval_runs.claim_epoch bigint NOT NULL DEFAULT 0`；`claim_next_run()` 每次 `+1`；
  心跳与结果写入都带 `WHERE id = $runId AND claim_epoch = $epoch`，影响行数 0
  ⇒ 立即放弃该 run 且不写任何结果。
- **剩余边界**：「宿主挂起」场景**没有专门的用例复现**（只在设计层面成立）。

### 4.4 T-1 / T-5 / T-6 — **三条均已在 M2 裁定**

| 编号 | 议题 | 裁定 | 落点 |
|---|---|---|---|
| **T-1** | `PG-01` 要不要 KPI 指标行（`DESIGN.md` §5.1 与 `SPEC-M1` `[FE-03]` 冲突） | **不加**。改 `DESIGN.md` 口径（KPI 行归属由「`PG-03`、`PG-01`」改为「仅 `PG-03`」） | `SPEC-M2` §1.2 |
| **T-5** | 窄视口下表格把文档撑宽（`/runs` @1024 文档 1337/1024 等） | **M2 支持视口定为 ≥1440**；T-5 记为**已知缺陷、不修**。1024 档只断言「不折行」，**不断言文档不溢出** | `SPEC-M2` §1.4 |
| **T-6** | `PG-04` 抽屉的「上一条 / 下一条」按钮 | **保留现状并正式纳入 M2 的 `PG-04` 清单**（`title` 标注 `K` / `J`；只有一条 Case 时不渲染） | `SPEC-M2` §1.5 |

> **T-5 若将来要求支持 1024**：升为 **P1 必修**，修法是给滚动容器加 `max-w-full`
> 或给 `<table>` 加 `min-w-0`/`w-max`，修完必须**三页一起复核**并补 1024 文档级断言。

### 4.5 未验证范围（原文见 `SPEC-M2` §6.4，此处只索引）

| 项 | 未验证的内容 |
|---|---|
| 真实厂商网关未接入 | 全程本地 fixture（`127.0.0.1:8787`）。真实厂商的限流、超时、非 200 响应、流式差异**均未验证**；分时计费未与真实账单对账 |
| LiteLLM sidecar 未起真容器 | 仅有配置产物逐字断言（`tests/litellm-sidecar.spec.ts`）。真实路由转发与并发限流**未验证** |
| 浏览器层 `EventSource` 未覆盖 | SSE 覆盖为「route 直调 + 客户端状态机单测 + 真栈 curl」三层。**没有用例驱动真实浏览器里的 `EventSource`** |
| `scripts/e2e-fail.ts` 未按原样运行 | 该脚本前置条件是 fixture **进程**已停，而 `dev:all` 是监督进程。改用同错误类（`ECONNREFUSED`）的等价手段（`provider.baseUrl` → `127.0.0.1:1`）。**未覆盖「fixture 进程真的不在」这一前置状态** |

### 4.6 环境事实（不是产品缺陷，但会误导复核）

| 现象 | 处置 |
|---|---|
| **`next dev` 的 jest-worker 子进程池会损坏** | 表现为**任意动态段 API 路由**持久 500，body 为 `"Jest worker encountered 2 child process exceptions, exceeding retry limit"`（`"source":"server"`）。受影响路由均已声明 `runtime='nodejs'` + `dynamic='force-dynamic'`，**不是缺 dynamic 导出**。**重启整个 dev 栈即恢复**。本会话谱系内已观察到 **3 次** |
| **`scripts/seed.ts` 对 provider 激活是破坏性的** | `upsertFixtureProvider` 的 `ON CONFLICT (name) DO UPDATE … is_active = EXCLUDED.is_active` ⇒ 每次 `db:seed` **和每次 `dev:all` 重启**都会把 `is_active` 重置为 `false`、`base_url` 重置为 `http://127.0.0.1:8787`。**跑真栈用例前必须重新激活 provider** |
| `tests/run-detail-keyboard.spec.ts` 的 `findFixture()` 用固定超时 | `/api/runs?limit=20` 用 `AbortSignal.timeout(2000)`、cases 用 `3000`。冷编译下会被击穿 ⇒ 打印原因并 `skipIf` 跳过 3 条。**这是 §2.6 第 1 次读数里最可能的 skip 来源之一**（该次未留 verbose 明细，故措辞为「之一」而非「就是」） |
| 剩余固定等待未全部替换 | `SPEC-M2` §6.4 只列了 4 处 `waitForTimeout`，**实查共 12 处调用**：`tests/` 下 11 处（`datasets-render-parity` 4 处 + `run-detail-keyboard` 7 处）、`scripts/check-datasets-render.ts` 1 处。其中**可判定但未替换的 8 处**：`datasets-render-parity:487`（300ms，合成 input 后等 React 提交）、`run-detail-keyboard` 7 处（`:155/:162/:222/:232/:287/:298/:310`，按键后等抽屉标题变化，`sheetTitle()` 就是现成探针）。其余 4 处是 `page.goto` 后等水合（`datasets-render-parity:349/:447/:559` + `check-datasets-render:163`），分类正确。**不影响 704 条的结论，影响「未验证范围」的准确性。建议 M3 开清理批次** |

### 4.7 已披露的过程偏差（不阻塞，但接手方需知道，别重新翻案）

| # | 偏差 | 结论 |
|---|---|---|
| 1 | **M2 Batch 1（`982fa1a`）改了 `contracts/src/db-schema.ts`（+19/−1）与业务代码同笔提交**，违反 `SPEC-M2` §1.6 第 4、5 条「契约只读 / 不得混在一笔」 | 属**过程违规**，但 `db-schema.ts` 是注册表非 API 形状、只增不改，**不构成产品风险**。请按 `ACCEPT with caveat` 记录 |
| 2 | `SPEC-M2` §1.1 要求 U-1 写入 **§5 / M2 合并说明 / `M1-验收记录.md` §13.4**，实际只有「M2 合并说明」兑现 | 「写到哪」的合规性丢失，**U-1 口径本身没丢**（§1.1 与 §6.4 都写全） |
| 3 | `SPEC-M2` §6.4 低估剩余固定等待（写 4 处，实为 12 处），且把 `:487` 的 300ms 误分类为「等水合」 | 不影响已通过结论，影响未验证范围的准确性 |
| 4 | `AGENTS.md` 的表/触发器计数过期（写 15 表 / 17 触发器） | **本次已在 `AGENTS.md` 修正为 16 表 / 19 触发器** |

> **一处「看起来过期但其实正确」的表述，别误判**：`docs/Spec/SPEC-M2.md` **§6.1** 写
> 「合并：**未合并 `main`**，等待需求方明确授权」—— 那是 **Batch 4 落笔时的事实快照**
> （`afe07c6` 尚未合并）。实际已于 2026-11-14 合并为 `5277fd5`。
> **不要在复核时把它记成缺陷**，也不要去改它（它合法地记录了自己写入那一刻的状态）。

### 4.8 文档口径问题（本次核对发现，**未擅自修改**）

**(A) 镜像不一致 —— 1 处**（`diff` 逐文件核对 `docs/` 下全部 14 个 `.md` 的结果）：

| 文件 | 不一致内容 | 风险 |
|---|---|---|
| `docs/facts/technical-solution.md` | **只有外层 `docs/` 副本有 §5.1「复核记录（2026-11-13 · M2 Batch 2）」**（LiteLLM 未在线核验的降级说明 + 两条实现约束）。`src/docs/` 副本与 `git show HEAD:docs/facts/technical-solution.md` 都**没有这一节** | **该内容只存在于未跟踪的外层文件里，随时可能丢失** |

> 其余 13 个文件（含 `HANDOFF.md` 同步后）逐字节一致。
> 复验：`for f in $(cd docs && find . -name "*.md"); do diff -q <(tr -d '\r' < "docs/$f") <(tr -d '\r' < "src/docs/$f"); done`

**(B) 同一份文档内部数字自相矛盾 —— 2 处（两份副本里都一样，不是镜像问题）：**

| # | 位置 | 冲突 |
|---|---|---|
| 1 | `docs/Spec/milestones.md` **:15** vs 实际 | :15 引用表写「`database-schema.md`（**15 表、17 触发器**、`T-01`…`T-22`）」；同文件 §2.3 也写「15 张表 / 17 个触发器」。**实际是 16 表 / 19 触发器** |
| 2 | `docs/facts/database-schema.md` **:9 vs :12** | :9 已写「**16 张**」；:12 括号里仍留「…合计 **15 张**。以本文件为准。」**同一段落两个数字并存，读者会取错** |

> **处置建议（待需求方确认，本文件不代拍）**：
> ① 把 §5.1 补进 `src/docs/facts/technical-solution.md` 并**单独提交**（`docs(M2): …`）；
> ② (B) 的两处按 `docs/工程规则.md` §10「保留原判定 + 追加复核行」处理，**不直接替换**历史表述；
> ③ 同步后**两份副本都必须一致**，否则下次交接仍会读到两套口径。

---

## 5. 四件「M2 启动前必须拍板」的事项 —— **全部已裁定，此处只列结论与落点**

> 这四件在原交接模板里写作「M2 启动前必须拍板」。**M2 已完成，四件全部有结论。**
> 接手方**不需要重新拍板**，但必须知道结论在哪、以及哪些结论绑着条件。

### 5.1 U-1 的处置

- **结论**：**接受挂着，固定口径**（2026-11-12 裁定）。
- **落点**：`docs/Spec/SPEC-M2.md` §1.1（含固定口径原文与关闭条件）、§6.4 第 1 行；M2 合并说明。
- **未兑现的落点**：`docs/Spec/M1-验收记录.md` §13.4（仍是 M1 时期表述）。
- **口径原文**见本文件 §4.1，**每次被问必须原样回答**。

### 5.2 T-1 / T-5 / T-6 逐条裁定

- **结论**：T-1 不加 KPI 行并改文档口径；T-5 支持视口 ≥1440、记为已知缺陷不修；T-6 保留按钮并纳入清单。
- **落点**：`docs/Spec/SPEC-M2.md` §1.2 / §1.4 / §1.5，汇总表见本文件 §4.4。

### 5.3 M2-1 / M2-3 的 Must / Should

- **结论**：**两者均为 Must-have，不是 Should**，都落在 **Batch 1**。
- **落点**：`docs/Spec/SPEC-M2.md` §1.3；实现见本文件 §4.2 / §4.3。

### 5.4 契约扩展流程

- **结论**：**先扩契约、单独提交锁定，再写业务代码**（2026-11-12 裁定）。
- **流程原样**（`docs/Spec/SPEC-M2.md` §1.6）：
  1. 在任务分支上**只改 `src/contracts/`**；
  2. 跑 `npm run typecheck`（含契约 workspace）与 `npm run lint`；
  3. **单独一笔 commit**，message 前缀 `contracts(M2):`（后续里程碑改前缀，如 `contracts(M3):`），正文列出新增/变更的 schema 名与理由；
  4. 该 commit 之后，后续批次**只读契约**，不得再改；
  5. 中途发现契约缺口 → **停下**、另开一笔契约提交，**不得与业务代码混在同一笔**。
- **已发生的违反**：见本文件 §4.7 第 1 条（`982fa1a`）。
- **依据**：`docs/工程规则.md` §3、§9（`WRITE_ONLY_FIELDS` 集中在 `contracts/src/api.ts:332`）。

### 5.5 若继续 M3，需要**新拍板**的事项（本文件**不越权代拍**）

> **✅ 状态更新（2026-11-14，需求方已裁定）**：以下六件已全部裁定，结论 + 理由 + 边界见
> `docs/Spec/SPEC-M3.md` §1 —— 逐件对应：1→§1.1（T-5）、2→§1.2（固定等待）、3→§1.3（U-1）、
> 4→§1.4（推送）、5→§1.5（tag）、6→§1.6（文档修正：先列矛盾清单，确认改法后执行）；
> 沿承未验证项的处置见 `SPEC-M3.md` §1.8。下文为写入时快照，保留不改：

以下事项**没有**在 M1/M2 裁定过，~~M3 启动前必须由需求方逐条拍板~~（已裁定，见上）：

1. **T-5 是否升级为 P1 必修**（若要支持 1024 视口）。
2. **§4.6 的 8 处可判定固定等待是否在本批清理**（建议单开清理批次）。
3. **U-1 的关闭条件什么时候执行**（CI 是否已就位；若 CI 是 Linux，需单独确认 `killTree` 语义）。
4. **`feat/m2-gateway-sse` 与本地 `main` 是否推送远端**（当前 7 个提交仅存在于本机）。
5. **是否打 `v0.1.0-m2` 标签**（目前只有 `v0.1.0-m1`）。
6. **§4.8 (A) 的 `technical-solution.md` §5.1 如何入库**（当前只存在于未跟踪的外层文件里；
   (B) 的两处计数矛盾是否一并修正）。

### 5.6 M4 起草义务（2026-11-15 裁定补充，防无限顺延）

M4 的 SPEC 起草时**必须**把 M2 沿承未验证项列为 **M4 的准入条件之一**——M4 Batch 1 的
准入闸门里必须有一条「**M2 未验证项已补验**」，不得无限顺延。清单以 `docs/Spec/SPEC-M3.md`
§1.8 为准：真实厂商网关（限流 / 超时 / 非 200 / 流式 / 账单对账）、LiteLLM sidecar 真容器
（路由转发与并发限流）、浏览器层 `EventSource`；`e2e-fail.ts` 原样运行随行。
U-1 的关闭条件独立走 `SPEC-M3.md` §1.3（CI 跑通 H-11 **且** `taskkill` 子孙清理分支被执行），
不并入本条。

---

## 6. 下一步（给 Zed 的启动指令）

> **口径说明**：交接模板的 §6 是按「M2 未启动」写的（读 M2 段 → 写 `SPEC-M2.md` → 不进 Batch 1 编码）。
> **M2 已完成并合并，故本节按 M3 重写。** 这是与模板的唯一结构性改动，已在交接报告中提请确认。

### 6.1 启动前的固定阅读（顺序不可跳，`AGENTS.md` §一）

1. `AGENTS.md`
2. `docs/工程规则.md`
3. `docs/facts/` 中与本任务相关的事实文档（做界面的任务**必须**加读 `docs/facts/DESIGN.md`）
4. `src/contracts/`
5. 当前 `docs/Spec/` 任务规格

### 6.2 恢复上下文的固定动作

```bash
cd "D:/Evaluation Middle Platform/src"
git log --oneline -9
git status --porcelain --untracked-files=all     # 本次交接后会有 2 个未提交项，见 §7
git rev-parse --short HEAD origin/main           # 5277fd5 / dc04385（7 ahead）
```

然后读 `docs/HANDOFF.md`（本文件）→ `docs/Spec/milestones.md` §4（M3 边界）→
`docs/Spec/SPEC-M2.md` §6（M2 自检与未验证范围）。

### 6.3 写 `docs/Spec/SPEC-M3.md` 的硬要求

1. **结构照抄 `SPEC-M1.md` / `SPEC-M2.md`**：§0 全局前置检查 → §1 前置裁定 → §2 批次编排 →
   §3 不做什么 → §4 与上一里程碑的衔接 → §5 与原始编排的差异 → §6 研发自检记录（含 §6.4 未验证范围）。
2. **§1 必须逐条列出 §5.5 的 6 件待拍板事项**，并留「待需求方裁定」状态，
   **不得自行填写裁结论**。
3. **范围必须来自 `milestones.md` §4.2**（`baselines` 提名/确认、`GET /api/compare`、
   `GET /api/compare/diff`、`PG-08`、`PG-04` 升级双栏、`US-010` 筛选），
   **不得自行扩大或缩小**。
4. **不得承接 §6.4 的未验证项作为「已完成」**：真实厂商、LiteLLM 真容器、浏览器 `EventSource`
   三项在 M2 就是**未验证**，M3 规格应显式说明是否在本里程碑补验。

### 6.4 编码前的硬红线（违反即停）

1. **契约只读**：M1/M2 期间锁定的契约只读；M3 若需扩展，按 §5.4 的 5 步走，**单独一笔 `contracts(M3):` 提交**。
2. **每批过门禁后提交，不把多个批次合成一个大 commit。**
3. **门禁全过才能提交**：`npm run typecheck` · `npm run lint:design` · `npm test`（外加合并前人工跑 `npm run check:datasets-render`）。
4. **跳过 ≠ 通过**：浏览器断言在无数据/服务未起时跳过，**必须打印原因**，且**不计入通过数**。
5. **不直接改 `main`**；不合并、不推送，**除非需求方明确授权**。
6. **不写密钥**；所有金额只由 `model_prices` 计算（`TS-2` 红线）；`WRITE_ONLY_FIELDS` 只写不读。
7. **`PROGRESS_RESUME_POLICY.mode='snapshot_only'` 不得修改**（需求方 2026-11-07 已拍板）。

### 6.5 接手方需要的第一条产出

**不是代码，是 `docs/Spec/SPEC-M3.md` 的 §1「前置裁定」**——
在需求方对 §5.5 六件事给出结论之前，**不进 M3 Batch 1 编码**。

---

## 7. 本次交接产生的未提交项（**未提交、未推送，等需求方决定**）

`git status --porcelain -uall`（在 `src/` 下）当前输出**恰好两行**：

```
?? AGENTS.md          ← 仓库内的入口指针（新增）
?? docs/HANDOFF.md    ← 本文件的入库副本（新增）
```

| 文件 | 性质 | 为什么未提交 |
|---|---|---|
| `src/AGENTS.md` | 新增，29 行。指向上一级 `../AGENTS.md` | `main` 受保护，且**提交 / 合并 / 推送都需明确授权**（`AGENTS.md` §二 第 4、8 条） |
| `src/docs/HANDOFF.md` | 新增，本文件的逐字节副本（镜像规则） | 同上 |

**没有修改任何已跟踪文件**，没有 `M` 状态，没有删除。

仓库**之外**本次也改了 3 个文件（不在任何 Git 里，不会出现在 `git status`）：

| 路径 | 性质 |
|---|---|
| `D:\Evaluation Middle Platform\AGENTS.md` | **实质更新**：新增 §零 目录布局、§四 当前阶段（M1/M2 已完成）、§五 门禁命令 + 测试库隔离 + 跳过≠通过、§六 契约只读规则、§七 提交纪律、§九 常用命令；删除全部 M1 前的过期表述 |
| `D:\Evaluation Middle Platform\CLAUDE.md` | **改写**：仍只转发 `AGENTS.md`，补充「Zed/Codex 不读本文件」与「以 `src/` 为工作区时读 `src/AGENTS.md`」 |
| `D:\Evaluation Middle Platform\docs\HANDOFF.md` | **新建**：本文件正本 |

**建议的提交方式（需授权后才执行，且必须分笔）**：

```bash
# 在 src/ 下，一笔只放这两份文档（不含任何业务代码）
git add AGENTS.md docs/HANDOFF.md
git commit -m "docs(handoff): 交接包与仓库内 AGENTS 指针"   # 过 pre-commit 三道门禁
```

> 不要与任何代码改动合成一笔；不要顺手 `git push`。

---

## 附：本文件的维护规则

- 本文件只写**事实与路径**，不写过程叙述、不写聊天摘要。
- 任何数字改动必须同时给出复验命令。
- 本文件**不修改**已合并的 commit / tag；发现历史偏差时按 §4.7 的方式**追加披露**，不改历史。
- 与 `src/docs/HANDOFF.md` 保持逐字节一致（镜像关系同其余 `docs/` 文件）。
