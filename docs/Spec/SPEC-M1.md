# SPEC-M1 · 核心底座与确定性评测闭环

> **本文件是 M1 的唯一范围依据。** 开发 Agent 与独立测试验收 Agent 使用**同一份** SPEC
> （`docs/工程规则.md` §5）。
>
> 里程碑边界见 [`milestones.md`](./milestones.md) §2。本文件只展开 M1 内部：
> 要建哪些表、用哪些契约、写哪些任务、按什么判完。
>
> 建立日期：2026-11-07 · 状态：**已确认**（需求方 2026-11-07 拍板）

---

## 0. 元信息

| 项 | 内容 |
|---|---|
| 里程碑 | **M1** |
| 定位 | P0 基石：不可变数据底座 + 异步跑批执行层 + 单次运行报告 |
| 归属故事 | `US-001` `US-002` `US-003`（仅规则算子）`US-005` `US-006` `US-008` `US-011`（单栏形态） |
| 交付页面 | `PG-01` `PG-02`（仅规则算子区块）`PG-03`（2s 轮询）`PG-04`（单栏）`PG-05` `PG-06`（T1 表单） |
| 上游里程碑 | 无 |
| 下游依赖 | M2（SSE / 裁判 / 真实网关）**不得重构**本里程碑的执行层骨架 |
| 编码前置 | `src/contracts/` 通过 `npm install` + `tsc --noEmit`；其 `README.md` 的编译状态声明在本里程碑内必须删除 |
| 规则依据 | [`../工程规则.md`](../工程规则.md)（TDD、真栈验收、安全）、[`../facts/DESIGN.md`](../facts/DESIGN.md)（视觉硬约束） |

---

## 1. M1 范围与架构对齐

### 1.1 数据库

**M1 一次性落地全部 15 张表 + 3 个横切迁移（共 18 个迁移文件）** —— 表结构的事实源已定稿
（`database-schema.md` §2，15 表 / 17 触发器），分批建表只会制造外键与迁移顺序问题。
> 第 18 个迁移 `0018_heartbeat_lease.sql`（心跳租约）是 M1 执行期发现真缺陷后的补充，
> **已获需求方批准纳入 M1**（裁定 `Q2 = A`）：它只给 `eval_runs` 加一列 `heartbeat_at`
> 并改 `reclaim_stale_runs()` 的回收谓词，不动 15 张表的形状，也不新增触发器。
但**只有 10 张表在 M1 有真实写入**（8 张由应用写入 + 2 张仅由种子写入），
其余 5 张随 M2–M4 逐级点亮。

| # | 表 | M1 写入路径 | 说明 |
|---|---|---|---|
| 1 | `datasets` | ✅ | `PG-05` 创建 |
| 2 | `dataset_versions` | ✅ | 导入即新版本 |
| 3 | `dataset_cases` | ✅ | 随版本写入 |
| 4 | `model_providers` | ⚠️ 仅种子 | M1 只有 fixture 网关一行（§3 `[BE-01]`）；`PG-09` 在 M2 |
| 5 | `model_prices` | ⚠️ 仅种子 | fixture 单价固定 `0`（§6.3） |
| 6 | `targets` | ✅ | `PG-06` 创建 |
| 7 | `target_versions` | ✅ | 创建 / 更新即新版本 |
| 8 | `evaluators` | ❌ 空表 | 全局模板库是 P1，`PG-07` 在 M4；M1 只用内置 key |
| 9 | `eval_runs` | ✅ | `POST /api/runs` → worker → 终态 |
| 10 | `run_evaluators` | ✅ | 建 run 时快照 |
| 11 | `eval_case_results` | ✅ | 逐条写入 |
| 12 | `baselines` | ❌ 空表 | M3 |
| 13 | `regression_gates` | ❌ 空表 | M4 |
| 14 | `gate_evaluations` | ❌ 空表 | M4 |
| 15 | `case_human_labels` | ❌ 空表 | 首版无界面（`OUT-5`），仅保证模型不堵死 |

**迁移文件清单**（文件名与 `db-schema.ts` 的 `MIGRATION_ORDER` 逐字一致，改名即测试失败）：

```
src/db/migrations/
├── 0001_datasets.sql … 0015_case_human_labels.sql   ← 15 张表，严格按序
├── 0016_immutability_triggers.sql                    ← 17 个触发器
├── 0017_queue_functions.sql                          ← claim_next_run / reclaim_stale_runs
└── 0018_heartbeat_lease.sql                          ← 心跳租约：eval_runs.heartbeat_at + reclaim 谓词
```

Drizzle schema 只做**镜像**（`technical-solution.md` `TS-4` 短板 3：Drizzle 表达不了触发器，
必然存在漂移风险）。漂移的唯一护栏是 `T-10` 触发器存在性断言 —— **不可省略**。

### 1.2 `src/contracts/` 使用范围

M1 **只读用**既有契约，**不得新增 / 修改任何契约文件**。缺什么就在 §6 登记，不在 M1 里私加。

> **唯一的例外，已获需求方裁定（`Q2 = A`）**：`db-schema.ts` 的 `CROSS_CUTTING_MIGRATIONS`
> 追加了 `0018_heartbeat_lease.sql` 一项（5 行）。理由：该常量是**迁移清单的登记表**，
> 不是业务契约 —— 迁移文件与 `MIGRATION_ORDER` / `CROSS_CUTTING_MIGRATIONS` 必须逐字一致
> （§1.1 的「改名即测试失败」），加了迁移文件却不登记，反而会让登记表与磁盘失配。
> 这属于**登记同步**，不改变任何对外 API 形状、字段类型或校验规则。
> 除此之外 M1 未新增 / 修改任何契约文件。

| 契约文件 | M1 用到的导出 | 用途 |
|---|---|---|
| `common.ts` | `Uuid` `IsoDateTime` `Score` `Money` `CaseResultStatus` `RunStatus` `TERMINAL_RUN_STATUSES` `isTerminalRunStatus` `ALLOWED_RUN_TRANSITIONS` `canTransitionRun` `PageQuery` `PageMeta` `JsonObject` `ErrorCode` `ApiError` `ErrorResponse` `WORKSPACE_DEFAULT` | 全部 |
| `dataset.ts` | `Dataset` `DatasetCreate` `DatasetUpdate` `DatasetVersion` `DatasetVersionCreate` `DatasetVersionDetail` `DatasetCase` `DatasetCaseInput` `CaseInput` `CaseReference` `RetrievalAnnotation` `ImportIssue` `ImportValidationReport` `RetrievalReadiness` `DATASET_SCHEMA_VERSION` | `PG-05` / 导入 / preflight |
| `target.ts` | `Target` `TargetCreate` `TargetUpdate` `TargetVersion` `TargetVersionConfig` `TargetVersionConfigView` `T1TargetConfig` `TARGET_T2_ENABLED` | `PG-06` / `PG-02` 步骤 2 |
| `evaluator.ts` | `BuiltinEvaluatorKey` `EVALUATOR_REQUIRES_RETRIEVAL` `RuleEvaluatorConfig` + 六个 `*Config` `EvaluatorConfig` `evaluatorKindOf` `RunEvaluatorInput` `RunEvaluator` `OperatorScore` `OperatorScoreList` | 算子配置与落库 |
| `run.ts` | `EvalRun` `EvalRunDetail` `EvalRunCreate` `EvalRunCounts` `EvalRunMetrics` `RunConfigSnapshot` `Reproducibility` `TriggerSource` `EvalCaseResult` `deriveTerminalStatus` `mustNullScore` `primaryMetricOf` `assertMutable` `canCancel` `canNominateBaseline` | 建 run / 执行 / 详情 |
| `provider.ts` | `ModelProvider` `ModelPrice` `computeCost` `CostInput` | 种子数据与成本计算 |
| `api.ts` | `DatasetListResponse` `DatasetVersionListResponse` `DatasetCaseListResponse` `TargetListResponse` `TargetVersionListResponse` `EvalRunListResponse` `EvalCaseResultListQuery` `EvalCaseResultListResponse` `RunPreflight` `RunPreflightQuery` `CaseDetailResponse` `DatasetImportValidate` | 路由入出参 |
| `db-schema.ts` | `TABLE_NAMES` `MIGRATION_ORDER` `CROSS_CUTTING_MIGRATIONS` `FULLY_IMMUTABLE_TABLES` `TERMINAL_FROZEN_TABLES` `TRIGGER_NAMES` `EXPECTED_TRIGGER_COUNT` `QUEUE_FUNCTION_NAME` `RECLAIM_FUNCTION_NAME` `DB_FUNCTION_NAMES` `RUN_PROGRESS_CHANNEL` | 迁移与迁移测试 |
| `eval-contracts.ts` | `OperatorContext` `EvaluatorOperator` `CompositeScore` `composeCaseScore` `roundScore` `RetrievedContext` | 算子引擎与合并口径 |
| `sse.ts` | `CaseEvent`（**仅取字段形状做轮询适配**，不建 SSE 端点） | `LiveRunProgressBar` 的 props 契约 |

**M1 明确不用**：`gate.ts`（M3/M4）、`sse.ts` 的运行时端点、`ModelProviderCreate` / `ModelProviderUpdate`（M2）。

### 1.3 页面路由

Next.js 15 App Router。**不设首页**，`/` 直接重定向到 `/runs`（`pages-and-flows.md` §0.3）。

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` → `/runs` | — | `redirect()`，不留欢迎页 |
| `/runs` | `PG-01` 评测运行台 | 列表 + 空状态 + 前置横幅 |
| `/runs/new` | `PG-02` 发起评测向导 | 整页 4 步；M1 只有第 3 步的「确定性规则算子」区块 |
| `/runs/[runId]` | `PG-03` 评测运行详情 | 可直达 URL（`pages-and-flows.md` §6）；2s 轮询 |
| `/datasets` | `PG-05` 评测集 | 列表 + 上传面板 + 版本历史；版本预览为同页内联展开 |
| `/targets` | `PG-06` 待测目标 | 列表 + T1 表单 |

**`PG-04` 不是路由。** 它是 `PG-03` 内的 Overlay 抽屉，打开态**只存在组件 state 中**：

- ❌ 不写入 URL（不用 `?case=`、不用 `[caseKey]` 段路由）；
- ✅ 刷新页面 → 抽屉关闭，回到 `PG-03` 列表。

依据：`pages-and-flows.md` `PG-04`「不提供直达 URL，刷新后回到 `PG-03`」、
`DESIGN.md` §1.3 第 2 条。用 `searchParams` 会让抽屉变成可分享 URL，即违反该条。

> **路由设计要点**：`/runs/new` 与 `/runs/[runId]` 并存，App Router 的静态段优先于动态段，
> `/runs/new` 会命中向导页而**不会**被当成 `runId`。但 `runId` 必须按 `Uuid` 校验：
> 非法 UUID → `notFound()`，不得把任意字符串塞进 SQL 参数。

**侧边导航只渲染有真实页面的分区**：M1 渲染「运行」（`PG-01`/`PG-02`/`PG-03`）与
「资产」（`PG-05`/`PG-06`）。「算子」「管理」两个分区在 M4 交付时加入。

> 这与 `DESIGN.md` §1.3 第 4 条「只有 4 个分区，不得新增第 5 个」不冲突 —— 该条禁止的是
> **新增第 5 个分区**，不是要求 M1 就渲染四个空分区。渲染不可点的导航项等于假功能。

### 1.4 目录结构与分层

```
src/
├── contracts/                    ← 已存在，M1 只读用
├── package.json                  ← 根工作区（npm workspaces）
├── db/
│   ├── schema/                   ← Drizzle 镜像（15 表）
│   ├── migrations/               ← 0001…0018 手写 SQL
│   ├── repo/                     ← 每表一个仓储；**SQL 只在这里出现**
│   └── seed/                     ← fixture provider + 单价 + RAG 基准集 JSONL
├── lib/
│   ├── operators/                ← 六个规则算子（实现 EvaluatorOperator）
│   ├── gateway/                  ← OpenAI 兼容客户端（M1 只调 fixture）
│   ├── cost/                     ← computeCost 的唯一出口
│   └── queue/                    ← claim_next_run 调用 + reclaim 定时调度
├── worker/                       ← 常驻进程入口（只做编排）
├── app/                          ← App Router：页面 + Route Handlers（薄壳）
├── components/                   ← shell + 三个评测专用组件
├── tools/fixture-gateway/        ← M1 本地回显网关（M2 摘除）
└── tests/
```

**依赖方向（单向，违反即架构腐化，由 ESLint `import/no-restricted-paths` 强制）**：
`app` / `worker` → `lib` → `db` → `contracts`。

- `app` 不得直接写 SQL（只能调 `db/repo`）；
- `lib/operators` **不得 import `db`** —— 算子必须是纯函数，否则六个算子会各自长出并发、重试、超时。

### 1.5 M1 数据流（一次跑批的全过程）

```
[1] POST /api/runs ── 单一事务 ───────────────────────────────────────────┐
    ├─ 重跑三条阻塞校验（凭证 / 算子 / 检索标注）→ 不通过 409 BLOCKED_*     │
    ├─ 读 dataset_versions.content_hash（锁定快照）                        │
    ├─ 快照 run_evaluators（config + weight + passThreshold + orderIndex） │
    ├─ 快照 model_prices（effective_from ≤ now() 取生效单价）              │
    ├─ 写 config_snapshot + reproducibility{cachePolicy:'none'}           │
    └─ INSERT eval_runs(status='PENDING', total_cases=N)                   │
[2] Worker 主循环                                                          │
    ├─ claim_next_run() → 0 行则 sleep 200ms 再取                          │
    ├─ reclaim 定时器（默认 60s）→ reclaim_stale_runs('10 minutes')        │
    └─ 领到 → status 已为 RUNNING，started_at=now()                        │
[3] 逐条执行（p-limit(concurrency)，默认 4，上限 32）                       │
    ├─ 渲染 prompt 模板（{{input}} 等）→ POST fixture /v1/chat/completions  │
    ├─ 算子流水线（按 run_evaluators.order_index 串行）→ 只产 score+reason  │
    ├─ runner 回填 passed/threshold（D-6b）→ composeCaseScore() 加权+AND     │
    ├─ computeCost() → cost_target（fixture 单价 0 ⇒ 0）                   │
    └─ INSERT eval_case_results（UNIQUE(eval_run_id, case_key) 兜底幂等）  │
[4] 终态聚合（单一事务）                                                    │
    ├─ 三计数 + score_overall / pass_rate / coverage + P50/P95（DB 内算）   │
    ├─ tokens 汇总；cost_judge 恒 0（M1 无裁判算子）                        │
    ├─ deriveTerminalStatus() → COMPLETED / PARTIAL_FAILED / FAILED        │
    └─ 落终态 ⇒ trg_eval_runs_guard 冻结整行                               │
[5] 前端 2s 轮询                                                            │
    ├─ GET /api/runs/:id         → 计数 / 指标 / 状态                      │
    ├─ GET /api/runs/:id/cases   → 逐条结果（仅 RUNNING 期间）             │
    └─ 视觉：保留上一帧渲染并降透明度，禁止骨架闪烁（DESIGN §6）            │
```

**M1 不发 `NOTIFY`**：`RUN_PROGRESS_CHANNEL` 常量保留但无人订阅。M2 只需在 `[3]` 的写库事务后
加一次 `NOTIFY`，**不触碰 `[2]` / `[4]` 的任何结构**。

### 1.6 M1 运行时形态

| 进程 | 启动方式 | 说明 |
|---|---|---|
| `app` | `npm run dev` / `next start` | Next.js，`runtime='nodejs'` |
| `worker` | `npm run worker` | 独立常驻进程，与 `app` 无共享内存 |
| `fixture-gateway` | `npm run fixture` | **仅绑 `127.0.0.1`**，端口 `8787`；不监听 `0.0.0.0` |
| `postgres` | `docker compose up -d db` | PG 16 |

---

## 2. 契约使用明细与禁止项

| # | 规则 | 理由 |
|---|---|---|
| C-1 | **不得修改 `src/contracts/` 下任何文件**（含 `openapi.yaml`）。发现缺字段 → 记入 §6，M2 统一补 | 契约是事实层，实现反向改契约等于让需求迁就代码 |
| C-2 | 所有出站 JSON 必须先用契约 `.parse()` 校验再返回。**不得手搓响应对象** | 契约不 parse 就只是文档 |
| C-3 | `EvalCaseResult` 的两条 `.refine()` 必须生效：`status='OK'` ⇒ `score !== null`；`status<>'OK'` ⇒ `score === null`。**每条结果写入前必须过一次 `EvalCaseResult.safeParse()`**（拼装形状，非读回形状） | 非 OK 伪造分数是最危险的假数据；`mustNullScore()` 只覆盖 `FAILED` 终态，逐条结果靠这条 refine |
| C-4 | 分数与金额**禁止浮点累加后直接落库**：落库前过 `roundScore()`（`numeric(10,6)`）；成本过 `computeCost()`（返回已 `toFixed(8)`） | `MP-1`：`numeric` 而非 `float` |
| C-5 | 凭据只写不读：M1 的 `model_providers` 种子行不含任何真实 Key，`apiKeyCiphertext` 写占位值 `'fixture-noop'` | `WRITE_ONLY_FIELDS` 的物理兑现 |
| C-6 | `cost_total` **只从数据库生成列读**，禁止在 Node 里做 `costTarget + costJudge` | `ER-3`：三列不一致 |

---

## 3. 原子任务清单

> 每个任务必须能独立提交、独立测试、独立回滚。
> 依赖列写明「必须等哪个任务合并」，未写即可并行。

### `[BE-01]` 数据库初始化迁移与种子评测集

**目标**：在空库上一条命令建起全部结构，并种下 M1 演示所需的 fixture 网关与 RAG 基准集。

**交付物**

1. `docker-compose.yml`（`db` 服务，PG 16）+ `.env.example`（`DATABASE_URL` 占位，不含真实值）；
2. `src/db/migrations/0001…0015`：15 张表，列 / 约束 / 索引与 `database-schema.md` §2 **逐字一致**；
3. `src/db/migrations/0016_immutability_triggers.sql`：三个函数
   `reject_mutation()`（7 张完全不可变表 × 2 触发器）、`eval_runs_guard()`（单向流转 + 终态冻结）、
   `baselines_guard()`（只允许状态流转），合计 **17 个触发器**
   （名单以 `db-schema.ts` `TRIGGER_NAMES` 为准，不得自行增删）；
4. `src/db/migrations/0017_queue_functions.sql`：`claim_next_run()` + `reclaim_stale_runs()`；
5. `src/db/schema/*.ts`：Drizzle 镜像；`npm run db:migrate` 执行手写 SQL（**不用 drizzle-kit 生成 DDL**）；
6. `src/db/seed/`：
   - `fixture-provider.ts` —— `model_providers` 一行：`name='本地离线自检（fixture）'`、
     `kind='openai_compatible'`、`base_url='http://127.0.0.1:8787'`、`max_concurrency=8`、
     `api_key_masked='fixture-••••noop'`、`is_active=true`；
   - `fixture-price.ts` —— `model_prices` 一行：`model_id='fixture-echo-1'`、
     `display_name='Fixture Echo 1（离线自检）'`（该列 `NOT NULL`，不可省）、
     `input_price_per_1k=0`、`output_price_per_1k=0`、`currency='CNY'`、
     `effective_from=now()`（缺省即 now()；调价只增行、不改行，见 `MP-2`）；
   - `rag-benchmark.jsonl` —— **20 条** RAG 问答样本（演示用最小集），每条必须同时具备
     `case_key` / `input.query` / `reference.golden_answer` / `reference.reference_facts` / `retrieval.relevant`；
     其中**至少 3 条** `reference_facts` 含 ≥2 个数值、**至少 2 条**标注里有一条 `grade=0` 的干扰项、
     **至少 2 条**的 `relevant` 完全不出现在预期召回里（用于构造 Recall=0 的真实 0 分）；
7. `src/tests/fixtures/cases-50.jsonl` —— **AC-2 / AC-6 用的 50 条验收集**（测试夹具，不进种子）。
   与种子集分开的理由：种子集要人能读懂，验收集只需覆盖数量与分布。两者都必须是合法
   `DatasetVersionCreate`；`case_key` 全局唯一，含 `input.query` / `reference.golden_answer` /
   `retrieval.relevant`；
8. `src/tests/migrations.spec.ts`：**`T-01`…`T-22` 全部 22 条**（`database-schema.md` §6）。

**DoD**

- 空库 → `npm run db:migrate` → `npm run db:seed` 一次成功，可重复执行（幂等）；
- `migrations.spec.ts` 22 条全绿，其中 `T-10` 断言触发器数 = `EXPECTED_TRIGGER_COUNT` = **17**；
  `T-18` 断言 `DB_FUNCTION_NAMES` 两个函数均存在；
- 迁移文件内**不出现** `DROP TABLE`、`TRUNCATE`、`DELETE FROM`；
- `rag-benchmark.jsonl` 通过 `DatasetVersionCreate.parse()` 校验（写一条测试证明）。

**依赖**：—

---

### `[BE-02]` 确定性评测算子引擎与黄金精度单测

**目标**：六个规则算子以纯函数形态实现 `EvaluatorOperator` 接口，并有可手工复算的黄金用例。

**交付物**

1. `src/lib/operators/` 六个实现 + `index.ts` 工厂（`key → EvaluatorOperator`）；
2. 每个算子声明 `requiresRetrieval`，**必须与 `EVALUATOR_REQUIRES_RETRIEVAL` 逐键相等**
   （写一条测试断言两处一致，避免两处漂移放行注定失败的算子）；
3. `src/lib/operators/__tests__/`：**每算子 ≥4 条边界用例**，期望值在测试里写明推导过程；
4. `composeCaseScore()` 的单元测试：加权均分、`weight=0` 只记录不计入、AND 判定、
   `weight` 全为 0 时 `score=null`、`hasConflict` 的三种情形。

**算法口径（锁定，实现与测试都以此为准）**

| 算子 | 定义 | 边界 |
|---|---|---|
| `recall_at_k` | `relevant = {doc_id \| grade ≥ gradeThreshold}`；`hit = recalled[0..k) ∩ relevant`；`score = \|hit\| / \|relevant\|` | **`\|relevant\| = 0`（标注存在但 grade 全低于阈值）⇒ 返回 `0`，不得 `NaN`**；召回为空 ⇒ `0` |
| `mrr` | 召回列表第一个 `grade ≥ gradeThreshold` 的位置 `i`（1-based）→ `1/i` | 无命中 → `0` |
| `ndcg_at_k` | `DCG = Σ_{i=1..k} (2^g_i − 1) / log2(i+1)`，`g_i` = 第 i 位召回的 `grade`（不在标注中记 0）；`IDCG` = 标注 grade 降序截取前 k 同式；`score = DCG / IDCG` | **`IDCG = 0` ⇒ 返回 `0`，不得返回 `NaN` / `Infinity`** |
| `json_schema` | `extractFromText` 时先从文本抽 JSON 块；`ajv` 校验 `schema` | 抽取失败 / 校验失败 → `0`；`reason` 给出首个错误路径 |
| `regex` | `RegExp(pattern, caseSensitive ? '' : 'i')` 命中 ⇔ `shouldMatch` | `shouldMatch=false` 而命中 → `0` |
| `numeric_fidelity` | 从 `outputText` 按出现顺序正则抽全部数值 `N`；对 `reference.reference_facts` 每个条目：数字值按 `\|x−v\| / max(\|v\|,1e-12) ≤ tolerance` 在 `N` 中找匹配，非数字按精确子串包含；`score = 命中数 / fact 总数` | **无任何 fact 时由 `missingFails` 决定**：`true` ⇒ `score=0`；`false` ⇒ `score=1`；`reason` 必须写明走了哪一支。**`passed` 不在这里判**（见下方职责边界） |

**DoD**

- 六算子测试全绿，全部为**确定性**用例（无随机、无网络、无真实时钟）；
- `ndcg_at_k` 的 `IDCG=0` 用例显式存在，断言结果 `=== 0` 且 `Number.isFinite(result)`；
- `score()` 任一实现**不抛出**业务异常（抛错语义只允许留给 runner 的 FAILED 路径）；
- 算子包**不 import `db`**（ESLint 边界规则验证）。

**职责边界（锁定，BE-02 与 BE-03 的分工线）**

| 字段 | 谁填 | 说明 |
|---|---|---|
| `score` | **算子** | `[0,1]`，已归一化 |
| `reason` | **算子** | 结构化摘要 / 分支说明，必填非空 |
| `passed` | **runner** | 由 `RunEvaluatorInput.passThreshold` 与 `score` 比较得出；`passThreshold` 缺省 ⇒ `passed = null` |
| `threshold` | **runner** | 回填该算子实际使用的阈值，无阈值则 `null` |

**算子自身一律返回 `passed: null, threshold: null`**。理由：`OperatorScore.passed` 的契约注释是
「`null` ⇒ 该算子未设阈值」，阈值属于**运行实例**（`run_evaluators.pass_threshold`）而非算子配置
（`*Config` 里没有任何 `threshold` 字段）。若让算子自己判 `passed`，同一份 `*Config`
在不同 run 里会给出自相矛盾的 `passed`，且 `composeCaseScore` 的 AND 语义会被两处逻辑争夺。

**DoD 补充**：写一条测试，把 `numeric_fidelity(missingFails=true)` 的返回直接与
`passed: null` 断言相等 —— 防止有人在算子里偷偷判通过。

**依赖**：—（可与 `[BE-01]` 并行，只用 `OperatorContext` 纯数据构造用例）

---

### `[BE-03]` 评测集管理 API 与 EvalRun 执行 / 汇总 API

**目标**：把 `[BE-01]` 的结构和 `[BE-02]` 的算子接成真实可跑的 HTTP + worker 链路。

**交付物**

1. `src/db/repo/`：`datasets` `datasetVersions` `datasetCases` `targets` `targetVersions`
   `evalRuns` `runEvaluators` `evalCaseResults` `modelProviders` `modelPrices` 仓储；
   **SQL 只出现在这一层**；
2. Route Handlers（全部走 `runtime='nodejs'`）：

| 方法 | 路径 | 对应 | 备注 |
|---|---|---|---|
| `GET`/`POST` | `/api/datasets` | `PG-05` | 名称单工作区唯一（`ux_datasets_workspace_name`） |
| `GET`/`PATCH` | `/api/datasets/{id}` | `PG-05` | PATCH 仅名称 / 描述 |
| `POST` | `/api/datasets/imports/validate` | `PG-05` 上传面板 | 返回 `ImportValidationReport` |
| `GET`/`POST` | `/api/datasets/{id}/versions` | `PG-05` | POST = 导入并生成版本 |
| `GET` | `/api/datasets/{id}/versions/{versionNo}` | `PG-05` 预览 | 返回 `DatasetVersionDetail`（`immutable: true`） |
| `GET`/`POST` | `/api/targets` | `PG-06` | POST 同时生成 v1 |
| `GET`/`PATCH` | `/api/targets/{id}` | `PG-06` | PATCH：`config` 变化才产生新版本号 |
| `GET` | `/api/targets/{id}/versions` | `PG-06` | |
| `GET` | `/api/targets/versions/{targetVersionId}` | `PG-02` 步骤 2 | |
| `GET` | `/api/runs/preflight` | `PG-01` 横幅 / `PG-02` 步骤 3 | 返回 `RunPreflight` |
| `GET`/`POST` | `/api/runs` | `PG-01`/`PG-02` | POST = 入队，返回 `EvalRunDetail` |
| `GET` | `/api/runs/{runId}` | `PG-03` | 含 `configSnapshot` / `reproducibility` / 算子快照 |
| `GET` | `/api/runs/{runId}/cases` | `PG-03` 明细 | M1 只启用 `sortBy` + `order` |
| `GET` | `/api/runs/{runId}/cases/{caseKey}` | `PG-04` | 返回 `CaseDetailResponse` |

3. `src/lib/import/`：JSONL / CSV 解析器 + 校验器（逐行错误，1-based 行号）；
4. `src/lib/gateway/`：OpenAI 兼容客户端（`POST /v1/chat/completions`），
   超时 / 5xx / 429 → 有限次指数退避，仍失败则 `FAILED` / `QUOTA_EXCEEDED` 且 `score=NULL`；
5. `src/lib/cost/`：查价 + `computeCost()` 唯一出口；
6. `src/lib/queue/`：`claim_next_run()` 调用 + `reclaim_stale_runs()` 定时调度；
7. `src/worker/index.ts`：主循环 + 优雅退出（`SIGTERM` 时跑完当前 Case 再退）；
8. `src/tools/fixture-gateway/`：本地回显网关（§3.1 契约）；
9. `src/tests/`：导入校验、preflight、`POST /api/runs` 事务、worker 端到端（真库、
   **不 mock 数据库**）。

**口径锁定**

| # | 口径 | 说明 |
|---|---|---|
| R-1 | `content_hash` = `sha256(canonicalJson)` 的 64 位小写 hex。canonical 规则：对象 key 递归字典序、数组保序、`cases` **按 `case_key` 升序**、UTF-8 | 同一内容任意行序 → 同 hash；保证「等价不新成版」可用 |
| R-2 | `seq` = 按 `case_key` 升序的 0-based 下标 | 跨版本稳定，Diff 对齐顺序一致 |
| R-3 | `case_key` 缺省时 = `sha256(canonicalJson(input))` 前 16 位 hex | 与 `product-overview.md` §7.1「规范化 input 的 hash」一致 |
| R-4 | `content_hash` 与该数据集已有版本相同 → **`409 CONFLICT`**，`details.existingVersionNo` 给出已有版本号，**M1 不产生新版本**。⚠️ 与 `database-schema.md` §2.2 存在张力，见 §6.2「已知冲突 1」 | `openapi.yaml` 已声明 409「指纹不符或版本冲突」 |
| R-5 | `expectedContentHash` 与实际不符 → `409 CONFLICT`（传输截断保护） | `DatasetVersionCreate` 注释 |
| R-6 | `POST /api/runs` 三条阻塞校验**服务端必须重跑**：`BLOCKED_NO_PROVIDER_CREDENTIALS` / `BLOCKED_NO_EVALUATORS` / `BLOCKED_NO_RETRIEVAL_ANNOTATION` | 前端禁用按钮不构成保护 |
| R-7 | 检索算子的判定依据是**整个版本**：任一 Case 缺 `retrieval.relevant` 且选了检索算子 → `BLOCKED_NO_RETRIEVAL_ANNOTATION` | `RetrievalReadiness.state !== 'ALL'` 即阻断 |
| R-8 | 终态：全 `OK` → `COMPLETED`；`succeeded>0` 且有非 OK → `PARTIAL_FAILED`；`succeeded=0` → `FAILED`；`cancel_requested_at` 非空 → `CANCELLED`（M1 不产生） | `deriveTerminalStatus()` |
| R-9 | `score_overall = avg(score) WHERE status='OK'`；`pass_rate = count(passed IS TRUE) / total_cases`；`coverage = succeeded / total_cases`；**该 run 的 `run_evaluators` 无任何 `pass_threshold` ⇒ `pass_rate = NULL`**，不得落 0 | `OPEN-1` / `OPEN-5`；边界见 D-10 |
| R-10 | P50 / P95 用 `percentile_cont` **在 DB 内算**，不在 Node 里排序全量 | `technical-solution.md` §3.5 `[4]` |
| R-11 | 建 run 后**任何模板 / 单价变化不影响本 run**：执行期只读 `config_snapshot` | `PT-1` |
| R-12 | **`passed` / `threshold` 由 runner 回填**（算子只产 `score` + `reason`，见 `[BE-02]` 职责边界）：`passThreshold == null` ⇒ `passed = null`；否则 `passed = score >= passThreshold`，`threshold` 记该值 | 阈值属于运行实例，不属于算子配置（D-6b） |

**DoD**

- 端到端测试：空库 → 迁移 → 种子 → 导入 20 条 → 建 Target → `POST /api/runs`
  → 启动 worker → 轮询至终态 → 断言 20 行 `eval_case_results`、计数自洽、终态正确；
- worker 被 `SIGKILL` 后，`reclaim_stale_runs()` 把该 run 退回 `PENDING`，
  重新领取后**不产生重复行**（`UNIQUE(eval_run_id, case_key)` + 幂等 upsert）；
- 网关 5xx / 超时用例：该条 `FAILED` / `TIMEOUT`，`score IS NULL`，**组装不出 0 分**；
- `POST /api/runs` 的三条阻塞各有一条测试，`code` 精确匹配 `BLOCKED_*`。

**依赖**：`[BE-01]`（表与种子）、`[BE-02]`（算子）

---

### `[FE-01]` 遵循 `DESIGN.md` 的 shadcn/ui + Tailwind 全局工作台布局骨架

**目标**：把 `DESIGN.md` 的 Token、布局、数字排版、三态、Linter 门禁真正落到工程里。

**交付物**

1. `tailwind.config.ts`（**v3.4 语法**）+ `globals.css`：`DESIGN.md` §2.2 / §2.3 / §2.4 / §2.7 的
   `:root` 与 `.dark` 全量 Token，`@layer utilities` 的 `.num` / `.num-mono`；
2. `components.json`（shadcn/ui）+ Tailwind **v3.4** 兼容配置；
3. 字体本地化：`next/font/local` 或 `@fontsource/*`；**禁用 `next/font/google`**，
   `Inter` + `JetBrains Mono` 全部本地文件；
4. 布局骨架 `components/shell/`：侧边导航（220px / 折叠 56px）+ 顶部栏 48px + 内容区 24px 内边距；
5. 基础件：`DataTable`（TanStack Table `^8`，渲染真实 `<table>` / `<th scope>`）、
   `EmptyState`、`Skeleton`、`StatusBadge`（`RS-01`…`RS-06`，`DESIGN.md` §4.4 图标与 Token）；
6. ESLint 三条禁令（`AS-1` / `AS-2`）+ `import/no-restricted-paths` + stylelint `color-no-hex`，
   `npm run check:tokens` 脚本；
7. 主题切换（浅色为主，深色兼容）。

**DoD**

- `npm run lint` 在空项目与实现后均通过；人为写一个 `#ff0000` 字面量 → Linter **报错**（测试该门禁真的生效）；
- 任意表格列中的数字使用 `.num`，右对齐；无「大字号例外」（`DESIGN.md` §3.2）；
- 全站零外部请求：构建产物中无 `fonts.googleapis.com` / CDN 域名（静态扫描断言）；
- 布局无第 5 个导航分区；筛选器只有一行且在表格上方；
- `prefers-reduced-motion: reduce` 下所有动画归零。

**依赖**：—

---

### `[FE-02]` 评测集与版本管理页面（`PG-05`）与待测目标页（`PG-06`）

**目标**：能真实完成「导入 → 校验 → 生成不可变版本 → 预览明细」与「建 T1 Target」。

**交付物**

1. `/datasets`：列表（`名称 ｜ 最新版本 ｜ 条目数 ｜ 来源 ｜ 最近更新 ｜ 操作`）、
   上传面板（JSONL / CSV + 名称 + 校验结果区 + 「生成新版本」）、版本历史（内联展开预览）；
2. 校验结果区：`通过 N 条 / 失败 M 条`，失败逐行渲染
   `第 47 行：缺少 case_key 且 input 为空`（原文见 `pages-and-flows.md` §5）；
3. 版本详情顶部固定文案：「**版本 v3 已发布，不可修改。如需调整数据，请导入并生成新版本。**」
4. `/targets`：列表 + T1 表单（名称、类型、模型、Prompt 模板、`temperature`、`max_tokens`）；
   T2 选项**置灰并标注「P1 支持」**（`TARGET_T2_ENABLED = false`）；
5. 版本语义文案：「**保存后将生成 v2，历史运行仍引用 v1**」。

**DoD**

- 上传零通过时显示「没有可导入的有效记录，请检查文件格式。」且「生成新版本」不可点；
- 没有删除版本的入口，也没有导出入口（`pages-and-flows.md` `PG-05`「明确不做」）；
- 表格三态齐全（`AS-3`）：空状态 / 骨架 / 超长 `case_key` 截断+复制；
- 所有数据来自 `/api/datasets*`、`/api/targets*`，**组件内无任何写死的 Case 数组**。

**依赖**：`[FE-01]`、`[BE-03]`（接口可用）

---

### `[FE-03]` 实验概览台（`PG-01`）、发起向导（`PG-02` 规则算子区块）与运行详情（`PG-03` + `PG-04` 单栏）

**目标**：跑批能发起、能看进度、能看到汇总结论并逐条下钻。

**交付物**

1. `/runs`：列表列 `评测名称 ｜ 状态 ｜ 综合得分 ｜ 耗时 ｜ Token 成本 ｜ 发起人 ｜ 发起时间 ｜ 操作`；
   行操作仅「查看报告」；空状态「还没有评测记录。」+ `去导入评测集` → `/datasets`、
   `去创建待测目标` → `/targets`（原文，不得改写）；
   未配凭证横幅「尚未配置模型网关凭证，无法发起评测。［去配置］」——
   **M1 的种子已包含一个 `is_active=true` 的 fixture provider，因此正常演示时该横幅不出现**；
   「去配置」在 M1 指向 `PG-09` 占位提示（该页 M2 才建），不得做成死链。
   验收时用「把 fixture provider 置 `is_active=false`」来触发横幅（`RunPreflight.hasProviderCredentials=false`）；
2. `/runs/new`：整页 4 步向导，第 3 步**仅渲染「确定性规则算子」区块**，
   六个内置算子可勾选 + 内联参数（K 值 / Schema / 容差 / 正则 / 阈值）；
   三条阻塞校验在提交前触发，文案逐字取自 `pages-and-flows.md` §5；
3. `/runs/[runId]`：
   - 元数据栏含 **「EvalRun 可解释，不可复现。」**（`OPEN-4` 锁死句，原文，不得改写），
     可展开看 `temperature` / `top_p` / `max_tokens` / `seed` / `runner_version` /
     `model_version_string` / `prompt_template_hash` 与 `cache_policy: none`；
   - 汇总指标卡：`score_overall` 主位；`pass_rate` / `coverage` 次级；
     **`status='FAILED'` 时 `coverage` 提到主位**（`primaryMetricOf()`）；
   - `<LiveRunProgressBar />`：`PENDING` 显示「等待调度」（不是 `0 / 0 Cases`）；
   - 明细表列 `Case Key ｜ Query 摘要 ｜ 得分 ｜ 各算子得分 ｜ 耗时 ｜ Token ｜ 状态 ｜ 操作`，
     P0 仅「按得分升序 / 降序」；
   - `PG-04` 单栏抽屉：五个区块（输入 / 参考答案 / 输出单栏 / 检索上下文 / 打分明细），
     仅「关闭」按钮（`Esc` 亦可），无「人工改判」「提交修正」「加入回流」；
4. **轮询适配层**：`<LiveRunProgressBar />` 的 props 取 `CaseEvent` 字段子集
   （`completedCount` / `totalCount` / `score` / `passed` / `status` / `latencyMs`），
   由 2s 轮询的 `EvalRunDetail` + 计数派生填充。**M2 换 SSE 时 props 不变**；
5. 轮询实现：`RUNNING`/`PENDING` 期间每 2s 拉 `/api/runs/:id`；进入终态即停；
   页面不可见（`document.hidden`）时暂停，恢复可见立即拉一次；
   刷新时**保留上一帧渲染并降透明度**，禁止骨架闪烁（`DESIGN.md` §6）。

**DoD**

- 跑批进行中：进度计数只增不减，数字位宽不抖动（`min-w-[Nch]` + `.num`）；
- 终态后停止轮询（用网络面板或测试断言请求次数不再增长）；
- `FAILED` 运行：`score` 显示为「—」而不是 `0`；`coverage` 在主位；
- `PG-04` 打开后按 `Esc` 关闭且焦点归还触发行；刷新后抽屉关闭（不写 URL）；
- 无参考答案时显示「本条未提供参考答案」，无基线时显示「暂无基线，仅显示本次输出」（原文）。

**依赖**：`[FE-01]`、`[BE-03]`

---

### `[INT-01]` 前后端真栈联调（严禁 Mock）

**目标**：证明整条链路跑在真实数据库上，一次完整 M1 评测运行可复现地成功。

**交付物**

1. `docker compose up -d` + `npm run db:migrate` + `npm run db:seed` + `npm run dev` +
   `npm run worker` + `npm run fixture` 一条命令起的脚本（`npm run dev:all`）；
2. 联调记录 `docs/Spec/M1-验收记录.md`：每一步的命令、截图或终端输出、
   关键表的 `SELECT` 结果（`eval_runs` 一行、`eval_case_results` 计数与分数分布）；
3. 静态扫描证据：`src/app` 与 `src/components` 下无写死的 Case / EvalRun 数组
   （评审结论 + `grep` 输出）。

**DoD**

- 演示脚本在**干净数据库**上从零跑通一次完整 M1 运行，中间不手写 SQL 修补；
- 数据库中 `eval_runs` / `eval_case_results` 的行由应用写入（`created_by` = 应用侧固定标识）；
- 断开 `fixture-gateway` 后发起评测 → 该批 `FAILED` 且 `score_overall IS NULL`
  （证明前端不是自己在编分数）；
- 前端在数据库清空后刷新 → 显示真实空状态，而非残留数据。

**依赖**：`[BE-03]`、`[FE-02]`、`[FE-03]`

---

### 3.1 fixture 网关契约（`src/tools/fixture-gateway/`）

M1 的模型输出由本地回显网关提供。它必须**完整走 HTTP**，从而证明 T1 链路真实存在。

| 项 | 规则 |
|---|---|
| 监听 | `127.0.0.1:8787`，**不监听 `0.0.0.0`**；不发起任何外部请求、不做 DNS 解析 |
| 路径 | `POST /v1/chat/completions`（OpenAI 兼容） |
| 请求 | 接受 `model` / `messages` / `temperature` / `max_tokens`；其余字段忽略不报错 |
| 响应 | `choices[0].message.content` + `usage{prompt_tokens, completion_tokens, total_tokens}` |
| **确定性** | 同一 `messages` ⇒ **逐字节相同**的 `content` 与 `usage`。**禁止随机数、禁止时间戳进响应体** |
| 回显规则 | `content` = `"[fixture] "` + `messages` 中最后一条 user 内容的前 200 字符；`usage` 由 `messages` 字符数确定性推导 |
| 错误注入 | 查询参数 `?fail=timeout` / `?fail=500` / `?fail=429`，**或**环境变量 `FIXTURE_FAIL_MODE`（同三个取值，进程启动时读一次；未设 ⇒ 正常回显）。前者用于手动验证，后者用于 AC-7 这类需要「改配置→重启→再跑」的场景 |
| 慢速注入 | 环境变量 `FIXTURE_DELAY_MS`（默认 `0`）：每次响应前 `sleep` 该毫秒数。**仅供 AC-6.10 / AC-7(b) 这类需要「跑批持续足够久、进度可被观察到」的场景**，默认关闭。它只影响时序，不影响响应体 |
| 外部依赖 | 零。不用 express 以外的框架也可，但**不得引入任何需要联网安装以外的东西** |

> **错误注入的作用域**：`FIXTURE_FAIL_MODE` 是**网关进程级**开关，一旦打开，所有 `model_providers`
> 指向它的请求都失败 —— 这正是 AC-7(a) 需要的「全部 Case 失败」。
> 若只想让**部分**请求失败，改用一个 `base_url` 带 `?fail=...` 的第二条 provider 种子行；
> M1 验收不需要这个粒度，不建该种子。

> **M1 → M2 拆除清单**：种子 provider 置 `is_active=false`；`RunPreflight` 不再因它返回 `true`；
> `npm run dev:all` 不再启动 fixture；`src/tools/fixture-gateway/` 保留但**不进入默认路径**，
> 仅作为异常路径的测试替身。**`lib/gateway/` 的接口不变** —— 它是真实网关客户端，不是 fixture 客户端。

---

### 3.2 50 条验收集的可复算设计（`src/tests/fixtures/cases-50.jsonl`）

AC-2 / AC-6 / AC-7 共用这一份夹具。它必须是**可手算、可复算、零随机**的，
否则「`score_overall = 0.6`」就只是一个被写进断言的魔数。构造规则：

| 项 | 规则 |
|---|---|
| 条数 | 恰好 50，`case_key` 全局唯一（`case-0001`…`case-0050`） |
| 分布 | **前 30 条**的 `input.query` **开头**即含固定标记串 `FIXTURE-HIT-`（必须落在前 200 字符内，否则会被 §3.1 的回显截断规则吃掉）；**后 20 条**不含，且全文任何字段都不出现该串 |
| `reference.golden_answer` | 50 条全给（非空字符串）。`regex` 算子用不到它，但 AC-2 需要它满足「合法 `DatasetVersionCreate`」，且让夹具可在 AC-4/AC-5 的其他算子上复用 |
| `retrieval.relevant` | 50 条全给（≥1 项、`grade ≥ 1`），使整版本检索就绪（`D-5`），从而**任何**算子都不会被 `BLOCKED_NO_RETRIEVAL_ANNOTATION` 拦下 |
| `T1TargetConfig.promptTemplate` | `'{{input}}'`（原样透传 query），`temperature=0`、`maxTokens=64` |
| 得分链路 | fixture 回显 `"[fixture] " + query` ⇒ 含标记的 30 条 `regex` 命中（`score=1.0`），其余 20 条不命中（`score=0.0`） |
| 可复算性 | 只要 AC-6 的 Given 固定为上述配置，`score_overall` **必然**是 `30/50 = 0.6`，与时间、并发、机器无关 |
| 失败路径复用（AC-7 a） | `FIXTURE_FAIL_MODE=500` 时不看查询内容，50 条全部 `FAILED`、`score` 全 `NULL`，因此同一份夹具可复用 |

> **为什么不选 `numeric_fidelity` 作为 AC-6 的算子**：它依赖 `reference_facts` 的数值
> 与**回显文本中的数值**偶然吻合，一旦 fixture 回显规则微调（例如截断到 200 字符），
> 期望值就会漂移。`regex` 只断言「标记串是否出现」，与截断无关，是更稳的锚点。
> `numeric_fidelity`、`json_schema`、`recall_at_k`、`mrr`、`ndcg_at_k` 的精度由
> `[BE-02]` 的黄金单测覆盖（AC-4 / AC-5），不依赖本夹具。

---

## 4. 验收条件（Given / When / Then）

> **独立测试验收 Agent 必须逐条执行**，8 条全绿才算 M1 通过。
> 每条都给出可执行的判定方法，不接受「看起来对」。

### AC-1 · 迁移与不可变红线

- **Given** 一个空的 PostgreSQL 16 数据库
- **When** 依次执行 `0001…0018` 全部迁移（15 张表 + `0016` 触发器 + `0017` 队列函数 + `0018` 心跳租约）
- **Then**
  1. `pg_trigger` 中命中 `TRIGGER_NAMES` 的触发器数 **恰好为 17**（`T-10`）；
     （`0018` 不新增触发器，这个数不因它变成 18）
  2. `pg_proc` 中 `claim_next_run` 与 `reclaim_stale_runs` **均存在**（`T-18`）；
  3. `T-01`…`T-22` **22 条断言全部通过**，其中包含对 `dataset_versions` / `dataset_cases` /
     `eval_case_results` / `gate_evaluations` / `case_human_labels` / `target_versions` /
     `run_evaluators` 的 `UPDATE` 或 `DELETE` **抛异常**；
  4. `eval_runs` 置 `COMPLETED` 后任何字段 `UPDATE` 抛异常（`T-04`），
     `PENDING → COMPLETED` 抛异常而 `PENDING → RUNNING → COMPLETED` 成功（`T-05` / `T-06`）；
  5. 迁移脚本全文不含 `DROP TABLE` / `TRUNCATE` / `DELETE FROM`（静态断言）；
  6. `0018` 的列与回滚另行由 `tests/heartbeat.spec.ts` 的 H-01…H-03 覆盖：
     `eval_runs.heartbeat_at` 存在且可空、回滚后消失、前滚可重复执行（影子库）。

### AC-2 · 导入产生不可变版本，指纹可稳定复算

- **Given** 一份含 **50** 条合法 Case 的 JSONL（含 `case_key`、`input.query`、
  `reference.golden_answer`、`retrieval.relevant`）
- **When** 调用 `POST /api/datasets/imports/validate` 后调用 `POST /api/datasets/{id}/versions`
  （该数据集首次导入，尚无任何版本）
- **Then**
  1. 返回 `versionNo = 1`、`caseCount = 50`、`immutable = true`；
  2. `dataset_cases` 落库 50 行，`case_key` 唯一，`seq` 为 `0…49` 且按 `case_key` 升序排列；
  3. **同一份文件再导入一次** → 返回 `409 CONFLICT`，`details.existingVersionNo = 1`，
     且 `dataset_versions` 行数仍为 **1**（未产生 v2）；
  4. **仅打乱同一批 Case 的行顺序**再导入 → 计算得到的 `content_hash` **与 v1 完全一致**，
     同样返回 409；
  5. 修改任一条 Case 的 `input.query` 再导入 → `content_hash` **变化**，产生 `versionNo = 2`，
     且 v1 的 50 行 `dataset_cases` **逐字节未变**（不可变红线）。

### AC-3 · 导入校验精确定位坏行

- **Given** 一个**已创建但尚无任何版本**的数据集；一份 **JSONL**（不含表头，物理行即数据行）
  共 **50** 行，其中第 `47` 行（1-based）缺少 `case_key` 且 `input` 为空；
  **同时另备一份等价的 CSV**：第 `1` 行是表头，坏行落在数据行第 `47` 条 ⇒ CSV 中位于物理行 `48`
- **When** 分别对两份文件调用 `POST /api/datasets/imports/validate`
- **Then**
  1. 两份都是 `failedCount = 1`、`okCount = 49`；
  2. JSONL 的 `issues[0].line === 47`；CSV 的 `issues[0].line === 48`
     （**表头计入物理行号**，口径见 D-11）—— 两种格式都**不是** 46、也不是 47/48 互换；
  3. `canCommit === false`；
  4. 前端「生成新版本」按钮不可点，JSONL 场景原样渲染
     「**第 47 行：缺少 case_key 且 input 为空**」（`pages-and-flows.md` §5 的示例文案即为 47）；
  5. 即使绕过前端直接 `POST /api/datasets/{id}/versions`，服务端也必须拒绝该批：
     **不落任何行**，`GET /api/datasets/{id}/versions` 仍返回**空列表**（连 v1 都不产生）。

### AC-4 · `recall_at_k(k=5)` 黄金精度

- **Given** 4 条手工构造的 `(retrieved[0..5), relevant)` 组合，覆盖：
  全命中 / 部分命中 / 零命中 / 命中位于第 5 位之后（K 外）
- **When** 执行 `recall_at_k` 算子（`k = 5`、`gradeThreshold = 1`）
- **Then**
  1. 四条期望值为 `1.0` / `0.6` / `0.0` / `0.0`（期望值在测试内以公式与列表显式写出）；
  2. 逐条断言 `Math.abs(actual - expected) <= 1e-6`；
  3. `grade = 0` 的召回项**不计入命中**；`grade >= 1` 但排名在 K 之外**不计入命中**；
  4. 同一输入重复执行 10 次，结果完全相同（纯函数，无随机、无时钟依赖）。

### AC-5 · 六算子边界矩阵与 `nDCG` 零增益

- **Given** 六个算子各 4 条边界用例（共 24 条），必须包含：
  `regex` 的 `shouldMatch=false` 命中反转、`json_schema` 的「输出无 JSON 块」、
  `numeric_fidelity` 的「容差临界值（相等）」与「`missingFails` 两种取值」、
  `mrr` 的「无命中」、`ndcg_at_k` 的「标注 grade 全为 0」
- **When** 逐条执行算子
- **Then**
  1. 24 条全部通过，逐条断言 `score` 精确匹配期望值（`±1e-6`），
     且 `passed === null && threshold === null`（算子的职责边界，见 `[BE-02]` 职责表）；
  2. **`ndcg_at_k` 在 `IDCG = 0`（标注 grade 全为 0）时返回 `0`**，
     断言 `result === 0` 且 `Number.isFinite(result)`，**不得为 `NaN` / `Infinity`**；
  3. `numeric_fidelity` 在「无任何 `reference_facts`」时：
     `missingFails=true` ⇒ `score=0`；`missingFails=false` ⇒ `score=1`；
     **两支的 `passed` 均为 `null`**，且 `reason` 非空并写明所走分支；
     阈值判定由另写的一条 runner 层测试覆盖（同一 `score`，`passThreshold=0.5` ⇒ `passed=false`；
     `passThreshold=0` ⇒ `passed=true`）；
  4. 六个实现的 `requiresRetrieval` 与 `EVALUATOR_REQUIRES_RETRIEVAL` 逐键相等（断言一致性）；
  5. `composeCaseScore()`：两算子 `[1.0, 0.0]` **且各自显式带阈值** ⇒ `score=0.5`、`passed=false`、
     `hasConflict=true` 且 `conflictNote` 列出双方 key；
     再测一组**都不带阈值**的组合 ⇒ `passed === null`、`hasConflict === false`。

### AC-6 · 一次 50 条真栈跑批的完整一致性

- **Given** 一份 50 条合法 Case 的版本 v1（即 `src/tests/fixtures/cases-50.jsonl`）、一个 T1 Target、
  一个 `regex(pattern='FIXTURE-HIT-', caseSensitive=false, shouldMatch=true)` 算子
  （`weight=1`、**`passThreshold=0.5`**），
  且 50 条按 §3.2「50 条验收集的可复算设计」构造为 **30 条命中（算子分 `1.0`）/ 20 条不命中（算子分 `0.0`）**
- **When** `POST /api/runs` 后启动 worker，轮询至终态
- **Then**
  1. run 建时为 `PENDING` 且 `total_cases = 50`；worker 经 `claim_next_run()` 领取后变 `RUNNING`；
  2. 终态 `COMPLETED`，`eval_case_results` **恰好 50 行**，`UNIQUE(eval_run_id, case_key)` 无冲突；
  3. 计数自洽：`succeeded_cases + failed_cases + skipped_cases <= total_cases` 且
     `succeeded_cases = 50`；
  4. **`score_overall` 恰好为 `0.6`**（`30 / 50`，误差 ≤ `1e-6`），且同时满足
     `score_overall = SELECT avg(score) FROM eval_case_results WHERE eval_run_id=$1 AND status='OK'`
     的库内计算结果 —— **不是**前端或 Node 侧另算的值；
  5. `pass_rate = 30 / 50 = 0.6`（`passThreshold=0.5` 使 30 条命中者 `passed=true`、
     20 条不命中者 `passed=false`，**不存在 `passed=null` 的条目**），
     断言它与 `SELECT count(*) FILTER (WHERE passed IS TRUE) FROM eval_case_results
     WHERE eval_run_id=$1` **除以 `eval_runs.total_cases`** 的库内结果一致
     （`OPEN-5` 口径：`pass_rate = passed / total_cases`，失败也进分母）；
     `coverage = 50 / 50 = 1`（`succeeded_cases / total_cases`）；
  6. **`cost_total` 读自数据库生成列，且等于 `cost_target + cost_judge`**；
     又因 fixture 单价为 `0`，断言 `cost_target = cost_judge = cost_total = 0`
     —— **fixture 不得产生任何虚假费用**；
  7. `tokens_in_total > 0` 且 `tokens_out_total > 0`（fixture 返回确定性 `usage`，Token 链路真实走通）；
  8. `run_evaluators` 恰 1 行且 `config` 与提交时逐字段一致（快照生效）；
     随后用**不同参数**（如 `pattern='FIXTURE-MISS-'`）再发起第二个 run，
     **第一个 run 的 `run_evaluators.config` 不变**，且第一个 run 重跑聚合仍得出
     `score_overall = 0.6`（`PT-1` 可追溯）；
  9. 每条 `eval_case_results` 的 `status='OK'` 行 `score` 非 `NULL`（`ck_eval_case_results_ok_score`）；
     **非 `OK` 行也必须由应用侧写 `NULL`** —— 数据库 CHECK 只单向强制「OK ⇒ 非空」，
     反向约束的载体是 `EvalCaseResult` 契约的第二条 `.refine()`（`status<>'OK' ⇒ score===null`），
     落库前的出站 `.parse()` 会拦下（见 §2 C-3），AC-7 会验证；
  10. 轮询期间 `completedCount` **单调不减**，终态后前端停止轮询
      （用 `FIXTURE_DELAY_MS=2000` 让跑批持续足够久，每 2s 采样一次计数序列并断言单增）；
  11. **三指标必须各自独立派生**：用同一份夹具、同一 Target 再发两次 run。
      **(b)** 仅把算子阈值改为 `passThreshold=0`（`0` 是合法阈值，`regex` 的 `0.0` 分也 `≥ 0`）：
      `score_overall` 仍为 `0.6`、`coverage` 仍为 `1`，而 **`pass_rate` 必须变成 `1.0`**；
      **(c)** 把 `passThreshold` **整个省略**（不传该字段）：`score_overall` 仍为 `0.6`、
      `coverage` 仍为 `1`，而 **`pass_rate` 必须为 `NULL`**（不适用，不是 `0`）。
      若实现的 `pass_rate` 直接取了 `score_overall`，(b) 会失败；
      若实现的 `pass_rate` 在无阈值时落 `0`，(c) 会失败 —— 三个指标严禁互相顶替（口径见 D-10）。

### AC-7 · 失败与中断路径的终态与主指标

- **Given** 已启动的 worker 与 fixture 网关；**(a) 的 run 沿用 AC-6 的算子配置（含 `passThreshold=0.5`）**
- **When** 分别执行两个场景：
  **(a)** 以 `FIXTURE_FAIL_MODE=500` 重启 fixture 网关，再发起一次 50 条跑批，让全部 Case 失败；
  **(b)** 以 `FIXTURE_DELAY_MS=2000` 重启 fixture 网关（使跑批持续足够久），
  在跑批进行中 `SIGKILL` worker，等待超过 stale 阈值后重启 worker
- **Then**
  **(a)**
  1. 终态 `status = 'FAILED'`，`score_overall IS NULL`（**不是 0**）；
  2. `coverage = 0`，`succeeded_cases = 0`；`ck_eval_runs_failed_null_score` 未被触碰；
     **`pass_rate = 0`**（本 run 配了 `passThreshold`，50 条全部未通过 ⇒ `0 / 50`；
     `OPEN-5` 的「失败计入分母视为不通过」正是在这里体现，见 D-10）——
     与 `score_overall = NULL` 形成对照：**质量不可评 ≠ 可用性为零**；
  3. `PG-03` 把 `coverage` 渲染在主指标位，`score` 显示「—」，`pass_rate` 显示 `0.00`；
  4. 50 行 `eval_case_results` 全部存在，`status` 为 `FAILED`/`QUOTA_EXCEEDED`，`score` 全为 `NULL`。
  **(b)**
  5. `SIGKILL` 后该 run 停在 `RUNNING`；`reclaim_stale_runs()` 被定时调度后把 `started_at` 置 `NULL`
     且 `status` 退回 `PENDING`（`T-13` / `T-14` 已在迁移测试覆盖，此处验证**真的被调度了**）；
  6. 重启 worker 重新领取并跑完，`eval_case_results` **行数仍为 50**（不重复计分），
     终态与该批实际结果相符；
  7. `Q-1` 红线成立：存在一处显式调用 `reclaim_stale_runs()` 的定时调度（代码可定位、有日志）。

### AC-8 · 无 Mock 冒充真栈

- **Given** M1 全部页面与接口
- **When** 做静态审查 + 三项运行时实验
- **Then**
  1. `src/app/**` 与 `src/components/**` 中**不存在**写死的 Case / EvalRun / 得分数组
     （评审逐文件核对 + `grep` 证据，形如 `const mockX = [...]`、`MOCK_`、`fixtures` 一律不允许）；
  2. **清空数据库后刷新 `PG-01`** → 显示「还没有评测记录。」而非残留数据；
  3. **停掉 worker 后发起评测** → run 永远停在 `PENDING`（前端不得自行推进进度）；
     为此需让该 run 可被观察到：先停 worker、发起 run、等待 ≥ 10s、断言 `status` 与
     `completedCount` 均未变化，再启动 worker 让它跑完（不得留下永久 `PENDING` 垃圾行）；
  4. **停掉 fixture 网关后发起评测**（或 `FIXTURE_FAIL_MODE=500`）→ 该批 `FAILED` 且
     `score_overall IS NULL`（前端不得自行编造分数）；
  5. 所有页面数据均可通过浏览器网络面板追溯到对应的 `/api/*` 响应。

---

## 5. M1 明确不做（不是缺陷）

| 不做的事 | 归属 | 依据 |
|---|---|---|
| SSE `/stream` 端点、`NOTIFY`、`LISTEN` | M2 | 前端用 2s 轮询拿同形状载荷 |
| LLM 裁判算子 + `PG-02` 第二配置区块 | M2 | 需真实裁判模型凭证 |
| `PG-09` 模型网关配置 Tab | M2 | M1 只有 fixture，配置界面此刻是假功能 |
| 中止（`US-014`） | M2 | fixture 近乎零成本，此刻没有要省的钱 |
| 提名 / 确认 Baseline、`PG-08`、双栏 Diff | M3 | 需已确认基线 |
| 逐条结果多维筛选（得分区间 / 算子 / 退化） | M3 | `US-010` 为 P1；`EvalCaseResultListQuery` 字段已存在但 M1 不启用 |
| 算子模板库 `PG-07` | M4 | `US-016` 为 P1 |
| 门禁 / 推送 / 台账 / T2 Target | M4 | `US-017`…`US-021` |
| 单条 Case 重跑、人工改判 | **永不** | `pages-and-flows.md` §7 |
| Badcase 回流 | **永不**（P2） | `US-012`、`PF-2` |
| 首页大屏 / 全局搜索 / 消息中心 / 用户管理 | **永不** | `pages-and-flows.md` §7 |
| 删除版本、导出 JSONL | **永不** | `PG-05`「明确不做」 |
| 换 `note` / `source` 对同一内容重新成版 | **M1 收窄不做** | 见 §6.2「已知冲突」—— 契约无显式确认字段，M1 一律 409 |

---

## 6. 契约缺口与命名对账（**必须知晓，不得自行发明**）

### 6.1 「`ExactMatch`」不是一个内置算子 key

任务简报中提到的 `ExactMatch`（精确匹配）与 `NumberFidelityValidator`（数值保真校验），
与 `src/contracts/src/evaluator.ts` 的 `BuiltinEvaluatorKey` 对账结果如下：

| 简报用词 | 结构对账结果 | M1 的落法 |
|---|---|---|
| `ExactMatch` | **不存在** `exact_match` key | 用 `regex` 算子表达：`pattern = '^…$'`（`caseSensitive` 按需）。**不新增 key** |
| `NumberFidelityValidator` | 对应 `numeric_fidelity` | 直接用 `numeric_fidelity` |
| `Recall@K` / `MRR` / `ndCG@K` | 对应 `recall_at_k` / `mrr` / `ndcg_at_k` | 直接使用 |
| `JsonSchemaValidator` | 对应 `json_schema` | 直接使用 |

**与 `工程规则.md` §4 的精度门禁清单的对账**（该节列的是「必须有黄金单测的项」，不是 key 名单）：

| `工程规则.md` §4 要求 | M1 的落点 |
|---|---|
| `Recall@K` / `MRR` / `nDCG@K` / JSON Schema / 数值保真度 | `recall_at_k` / `mrr` / `ndcg_at_k` / `json_schema` / `numeric_fidelity` —— **5 项在 M1 全覆盖**（AC-4 / AC-5） |
| `LLM-as-a-Judge 结果解析` | **M2**（`US-004`）。M1 无裁判算子，故该门禁项在 M1 不适用 |
| （§4 未列，但 `BuiltinEvaluatorKey` 有） | `regex` —— M1 必须实现并单测，它同时承担 `ExactMatch` 的表达职责 |

**结论**：M1 交付的是 `BuiltinEvaluatorKey` 的**六个** key
（`recall_at_k` `mrr` `ndcg_at_k` `json_schema` `regex` `numeric_fidelity`），
**不因命名差异新增第七个 key**；§4 的裁判解析门禁随 `US-004` 顺延到 M2。
若后续确实需要独立 `exact_match`（例如需要专门阈值与独立 reason 措辞），属**契约变更**，
须先改 `src/contracts/src/evaluator.ts` 与 `database-schema.md`，再排进里程碑 —— 不在 M1 内做。

### 6.2 M1 需要但契约缺失的接口

| 缺口 | 影响 | 处置 |
|---|---|---|
| `POST /api/providers/{providerId}/probe`（`US-015` 连通性测试） | M1 不用（无 `PG-09`） | **M2 补契约后实现** |
| `DatasetVersionCreate` 无「强制重新成版」字段 | 同内容无法再出一个版本 | **⚠️ 与事实文档存在张力，见下「已知冲突 1」，需需求方裁决** |
| `OperatorScore` 无「不可评」态 | 算子「算不了」只能表达为 0 或抛错 | M1 用既有 `missingFails` / `shouldMatch` 语义消解；`ndcg` 的零增益返回 `0`（见 AC-5）；**不新增字段** |
| `RunPreflight` 无「版本内 `reference_facts` 覆盖率」 | `PG-02` 无法提示数值保真算子的可用性 | M1 不做该提示，记入 M2 契约补充清单 |

**已知冲突 1 · 同内容重新成版（需需求方裁决）**

- `database-schema.md` §2.2 明确「`(dataset_id, content_hash)` 刻意不建 UNIQUE」，
  理由是**允许**「内容相同但有意重新成版」（换 `source`、补 `note`、重建评审基线），
  并写明「『等价则不产生新版本』是**应用层决策 + 用户确认**，不是数据库禁令」。
- `openapi.yaml` 的 `POST /api/datasets/{id}/versions` 把同 hash 归入 409
  「指纹不符或版本冲突」，而 `DatasetVersionCreate` **没有**任何「我确认要重新成版」的字段。
- **M1 的处置**：契约优先，一律 `409 CONFLICT`（AC-2.3 / AC-2.4 按此验收），
  即 M1 **放弃**「同内容重新成版」这条能力，仅保留数据库层的**不设限**。
  该能力在 M1 无故事消费方；若需求方要恢复它，正确做法是给 `DatasetVersionCreate`
  增加显式确认字段并同步 `openapi.yaml`，属**契约变更**，不在 M1 内做。
  → **需求方需确认这是可接受的 M1 收窄。**

**命名分歧 2 · `openapi.yaml` ↔ `api.ts` 的名字不一致**

| `openapi.yaml` 里的名字 | `src/contracts/src/api.ts` 里的名字 | M1 以哪个为准 |
|---|---|---|
| `EvalRunSummary` | `EvalRun`（`EvalRunListResponse.items`） | **`api.ts`** —— 运行时校验用 Zod；`openapi.yaml` 只是人读骨架 |
| `CaseDetail` | `CaseDetailResponse` | **`CaseDetailResponse`** |

两处不对齐不影响 M1（Zod 才是执行体），但**不要在 M1 里顺手改名**：改契约属预置事实变更，
须与 `openapi.yaml` 同批改并记录到 `src/contracts/README.md`。登记待办，M2 统一处理。

### 6.3 fixture 单价为何是 `0`

M1 不产生任何真实费用。给 fixture 模型填一个非零单价会让 `cost_target > 0`，
**等于给一次零成本运行伪造账单**，进而污染 M4 的成本台账。
因此：

- 种子单价固定 `0`；AC-6 断言三个成本列均为 `0`；
- 成本口径本身由 `computeCost()` 的单元测试（非零单价）与 `T-11`（生成列随分列变化）覆盖；
- **M2 起用真实单价与真实用量验证成本链路。**

### 6.4 已裁决的 M1 口径（实现必须照此，不再讨论）

| # | 议题 | 裁决 |
|---|---|---|
| D-1 | `content_hash` 与行序 | 按 `case_key` 升序规范化后计算，**行序变化不产生新版本**（AC-2.4） |
| D-2 | `seq` 来源 | 按 `case_key` 升序的 0-based 下标（跨版本稳定） |
| D-3 | 同内容重复导入 | `409 CONFLICT` + `details.existingVersionNo`；不产生新版本 |
| D-4 | `cases` 内 `case_key` 重复 | 导入期直接判该行失败（不依赖 DB 唯一约束在 COMMIT 时炸） |
| D-5 | 检索算子可用性 | 以**整版本**判定；`RetrievalReadiness.state !== 'ALL'` ⇒ `BLOCKED_NO_RETRIEVAL_ANNOTATION` |
| D-6 | 数值保真缺参考答案 | 由 `missingFails` 决定（只决定 `score`），`reason` 必须写明分支（AC-5.3） |
| D-6b | `passed` / `threshold` 的填写者 | **runner**，不是算子：`passed = score >= passThreshold`；算子一律返回 `passed: null, threshold: null` |
| D-7 | 进度条数据源 | 轮询派生的 `CaseEvent` 字段子集；M2 切 SSE 时 **props 不变** |
| D-8 | `PG-04` 打开态 | 仅组件 state，不写 URL，刷新即关闭 |
| D-9 | 侧边导航分区 | 只渲染有真实页面的分区（M1：运行 / 资产） |
| D-10 | 三指标互相独立 | `score_overall` = 均分、`pass_rate` = 通过率、`coverage` = 成功率，**三者不得互相顶替**。R-9 的边界：`pass_rate` 的**可计算性取决于该 run 是否配了阈值**，而不是逐条结果——**该 run 的 `run_evaluators` 里没有任何 `pass_threshold`** ⇒ `pass_rate = NULL`（「不适用」，落 `0` 会被读成「全部不通过」）；只要有一个算子配了阈值，`pass_rate = count(passed IS TRUE) / total_cases`（`OPEN-5`：失败计入分母、视为不通过，因此全 `FAILED` 的 run 是 **`0`** 而不是 `NULL`） |
| D-11 | 行号口径 | JSONL：**物理行号即 `line`**（空行也计数，1-based）。CSV：**第 1 行是表头，数据行从第 2 行起**，`line` 用物理行号（表头占 `1`）；表头缺失 / 列名不在约定集合内 ⇒ 整体失败，`issues[0].line = 1`。两种格式**都不跳过空行**——静默跳过等于隐藏数据丢失 |

### 6.5 M1 暂缓项与待办登记

> 只登记「M1 已知但有意不做」的项。**登记不等于放弃**，是让下一次接手的人知道
> 这是我们看过的决定，不是漏看。

| # | 项 | 现状 | 处置与去向 |
|---|---|---|---|
| T-1 | **`PG-01` 的 KPI 指标行** | `DESIGN.md` §5.1 的图表清单把「指标卡（KPI 行）」的应用页写成 **`PG-03`、`PG-01`**，§3.2 也把「指标卡（KPI 行）」列为必须 `tabular-nums` 的场景；但本节 `[FE-03]` 交付物 1 对 `/runs` 只列了「列表 + 空状态 + 前置横幅」，**未列 KPI 行**。两份文档在这一点上口径不一致 | **M1 按 `[FE-03]` 做，不加 KPI 行**（需求方 2026-11-10 裁定）。不带 KPI 的 `PG-01` 仍是完整可用的列表页，不构成 M1 缺项。若后续要补，须先同步 `[FE-03]` 的交付物清单与 `DESIGN.md` §5.1 的页面归属，并确定四张卡各自的取数口径（**必须是 `/api/runs` 已有字段**，不得新造聚合接口） |
| T-2 | **`PG-01` 的「准出门禁」列** | 原型有 `PASS 准出 / BLOCK 阻断` 列；本项目 `gate_evaluations` 在 M1 是 ❌ 空表（§1.1 第 14 行），`regression_gates` 同样空表 | **M1 该列显示「未评估」**，不填假值、不派生猜测值、不隐藏列（需求方 2026-11-10 裁定：`gate_evaluations` 空表期间门禁列显示「未评估」）。真实裁决随 M4 的 `US-017` 落地。**落地（2026-11-11，第 2 批）**：列插在「发起时间」之后、「操作」之前；组件 `components/runs/gate-badge.tsx` **零 props**（签名上就无从读 `status`/`metrics` 去派生裁决），列定义 `components/runs/runs-table-columns.tsx` 不给 `sortValue`；同时删除 `app/runs/page.tsx` 里 SPEC 交付物清单没有的裸「Token」列（Token 总数属 `PG-03` 指标卡，删除理由与去向登记在 §6.5 `T-4`）。回归由 `tests/runs-render-parity.spec.ts` 用真实 `<DataTable>` 渲染一条满分 `COMPLETED` 运行后逐字断言门禁单元格 = 「未评估」 |
| T-3 | **`PG-08` / `PG-07` / `PG-09` 三个页面** | `PG-08`（AB 对比）属 **M3**、`PG-07`（算子库）属 **M4**、`PG-09`（模型网关 / 门禁规则）属 **M2/M4**。补齐它们需要新增契约 + 新增迁移 + 新增路由，三者都在 §1.2 / §1.3 的 M1 授权之外 | **M1 只留占位路由**：显示「M3 / M4 上线」，侧栏对应项置灰。**不连数据、不画图、不加接口、不动契约**（需求方 2026-11-10 裁定的「方案 A」）。后续扩范围另开一轮 |
| T-4 | **`PG-01` 列表里被删除的裸「Token」列** | 基线实现（提交 `223d71b`）的 `/runs` 有 **10 列**，比 `[FE-03]` 交付物 1 多出一个裸「Token」列（`tokensInTotal + tokensOutTotal`，排在「耗时」与「Token 成本」之间）。**`[FE-03]` 交付物 1 与 `pages-and-flows.md` `PG-01` 区域 3 的列清单里都没有这一列** —— 两份事实源逐字相同，均为 8 列。该列是基线实现的**自造列**，不是 M1 要求 | **M1 删除该列**（需求方 2026-11-11 第 2 批指令：列集合逐字对齐 `[FE-03]`）。Token 总量并非无处可见 —— `PG-03` 详情页的指标卡有「Token 总量」（`lib/ui/runs.ts` 的 `metricCardsOf()`，取 `tokensInTotal + tokensOutTotal`，与列表里那个自造列同口径），逐条明细也有「Token」列（`[FE-03]` 交付物 3 的明细表列清单**明确列了**「Token」）。**本项无功能损失，不构成 M1 缺项**；若将来要在列表页直接看 Token 总量，须先改 `[FE-03]` 交付物 1 与 `pages-and-flows.md` 区域 3 的列清单，再改代码 —— 不得反向由代码驱动文档。回归由 `tests/runs-render-parity.spec.ts` 断言「表头不含裸 `Token`、但含 `Token 成本`」 |
| T-5 | **窄视口下表格把文档撑宽（全站既有缺陷）** | `components/ui/data-table.tsx` 的 `div.overflow-x-auto` 容器**没能真正拦住**表格撑宽文档：`TABLE.w-full` 在窄视口下自身宽度超过容器，`overflow` 只裁内容不改变自身的 min-content 宽度。**实测（真实 Edge，2026-11-11）**：`/runs` @1024 文档 `1337/1024`、`/datasets` @1024 `1069/1024`、`/targets` @1024 恰好 `1024/1024`；**1440 下三页均正常**（`1440/1440`）。三条路由同源，属 `DataTable` 单点问题，**不是某一页引入的** | **本批（第 2/4 批）不修，只登记**（需求方 2026-11-11 裁定：M1 不因一个全站既有缺陷扩范围）。修法方向：给滚动容器加 `max-w-full`、或给 `<table>` 加 `min-w-0`/`w-max` 让容器成为真正的约束边界；修的时候必须**三页一起复核**并补窄视口断言。**当前规避**：验收与回归只在 ≥1440 视口做几何断言（`tests/runs-render-parity.spec.ts` 的 1024 档只断言「不折行」，不断言文档不溢出）。**这是已知缺陷，不是「已验证没问题」**。<br>**⚠️ 视口范围未在事实文档中定义（2026-11-11 复核）**：查遍 `DESIGN.md` / `pages-and-flows.md` / `technical-solution.md`，**没有任何「最小支持视口」的规定**；唯一明确断点是 `DESIGN.md` §1.2「`PG-04` 抽屉 `<sm`（640px）全屏」，那是**抽屉内部**的布局规则，不是全站视口下限。原型 `ui-reference.html` 也没有响应式断点（`sm:` 仅 7 处，全是 `w-[…]` 固定宽）。**因此 M1 的视口下限无法从现有事实源推出** —— 独立验收请按 **≥1440** 执行几何断言（这是本批次实际验证过的视口，且 `DESIGN.md` 的布局骨架「侧栏 220 + 内容区」在 1440 下成立）。若需求方要求支持 1024，则 T-5 由「已知缺陷」升为 **P1 必修**（不是 M1 缺项，是缺陷优先级问题），并须在修完后补 1024 文档级断言 |
| T-6 | **`PG-04` 抽屉头部的「上一条 / 下一条」按钮** | 原型有这两个按钮（`ui-reference.html:614-615` 的 `↑ Prev [K]` / `↓ Next [J]`），`DESIGN.md` §4.3 的固定头规则也写了「上一条/下一条」，但 **`[FE-03]` 交付物 3 的 `PG-04` 条款只列了「五个区块 + 仅『关闭』按钮（`Esc` 亦可）」**，没有列这两个按钮；`DESIGN.md` §4.3 又明确要求 `J`/`K` 快捷键 —— 于是「有快捷键、没有可点的按钮」 | **M1 同时给快捷键与按钮**（需求方 2026-11-11 第 4 批指令：`J`/`K` 必须有，且要求「`INPUT`/`TEXTAREA`/`SELECT` 聚焦时不拦截」）。按钮是快捷键的可发现性载体：只给快捷键、不给按钮，用户不读文档就永远不知道 `J`/`K` 存在；按钮的 `title` 写明「上一条 (快捷键 K)」/「下一条 (快捷键 J)」。**只有一条 Case 时按钮不渲染**（「点了没反应」比「没有按钮」更糟）。**未越界**：按钮只切换**当前已加载的明细行**，不新增接口、不改契约、不增加抽屉内的写操作（`PG-04` 仍只有「关闭」一个动作按钮）。回归由 `tests/run-detail-keyboard.spec.ts`（真实浏览器：`J`/`K` 换人、作用域排除四件套、监听挂容器不挂 `window`）与 `tests/run-detail-ui-render.spec.ts`（结构前提）覆盖 |
| T-7 | **`[FE-02]` 的上传面板与版本历史（P4 完整交付核对）** | 这两块**已经在页面里**（基线提交 `223d71b` 即有），但**此前没有任何测试覆盖页面层**：`tests/datasets-ui.spec.ts` 只测 `lib/ui/datasets.ts` 的纯函数（`versionCell` / `importCanCommit` / `versionFrozenNotice` 等），证明不了「页面真的用了它们」。2026-11-11 第 5 批复核确认：三块均在，不是缺口 | **本批补齐页面级回归，代码未改**（先做行为级 RED 再验证 GREEN）。**上传面板**：文件选择（`accept` 含 `.jsonl`/`.csv`）、目标评测集下拉、可粘贴内容区、「校验」、「生成新版本」；校验**必须走服务端** `/api/datasets/imports/validate`（实测命中 1 次），前端**不得**自己 `JSON.parse` 逐行解析（行号口径只能有一处实现）；校验结果实测 `通过 2 条 / 失败 1 条` + 逐行 `第 3 行：[case_key] 缺少 case_key 且 input 为空`，`canCommit=false` ⇒「生成新版本」置灰。**版本历史**：点「查看版本」**内联展开**（URL 不变、无 `role="dialog"`）；版本行含 `version_no` / 条目数 / `content_hash` / 创建人 / 时间 / 「预览」；点「预览」渲染内层 Case 明细表（列 `Seq ｜ Case Key ｜ Query ｜ 检索标注`，种子版本 20 行），顶部不可变文案实测为 **「版本 v1 已发布，不可修改。如需调整数据，请导入并生成新版本。」**（版本号跟实际版本走，**不是**文档举例的 v3 —— 写死 v3 已用变异验证会红）。回归：`tests/datasets-render-parity.spec.ts` 的「上传面板」「版本历史」「真实浏览器行为」三组（共 9 条） |

---

## 7. 验收执行方式

| 项 | 要求 |
|---|---|
| 交付物 | 明确的提交 SHA + 自检结果（`npm run typecheck` / `lint` / `test` 输出） |
| 研发侧自检 | 至少 L1 单元测试 + L2 真实数据库与真实 worker 切片（`工程规则.md` §5） |
| 独立验收 | 独立测试验收 Agent 在**同一提交**上逐条执行 §4 的 AC-1…AC-8，禁止修改代码 |
| 缺陷扫描 | 韧性 / 横切一致性 / 防御编码 / 数据迁移 四类 |
| 证据留存 | 命令、终端输出、截图、关键 `SELECT` 结果；记录到 `docs/Spec/M1-验收记录.md` |
| 清除声明 | 「已通过」只对**实跑过**的检查项成立；未跑的项目须显式列为「未验证」 |
| 合并 | 验收全部通过后，按需求方**明确授权**合并 `main`；**上线另行确认** |

---

## 8. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-11-07 | 建立本文件 | M1 范围与架构对齐、7 个原子任务（`[BE-01]`…`[INT-01]`）、8 条 Given/When/Then、契约缺口与 M1 口径裁决 |
| 2026-11-08 | 回读核对修正 | ① 新增 §3.2「50 条验收集的可复算设计」，把 AC-6 的 `score_overall=0.6` 从魔数变成可手算结论，算子由 `numeric_fidelity` 改为 `regex`（不受回显截断影响）；② AC-6 补 `passThreshold=0.5`，新增 AC-6.11「三指标独立派生」（阈值 0 vs 0.5）；③ 新增 `[BE-02]` 职责边界表：`passed` / `threshold` 由 runner 填、算子只产 `score` + `reason`，据此修正 AC-5 与算法口径表中把 `passed` 写进算子的表述；④ `pass_rate` 的「无阈值 ⇒ `NULL`」边界写入 R-9 / D-10；⑤ AC-6.9 反向约束的载体更正为 `EvalCaseResult` 第二条 `.refine()`；⑥ fixture 网关补 `FIXTURE_FAIL_MODE` / `FIXTURE_DELAY_MS`（AC-7 需要进程级开关，URL 查询参数无法让全部 Case 失败），AC-7 / AC-8 的触发方式随之改写；⑦ AC-3 明确行号口径并新增 D-11（JSONL 物理行 / CSV 表头占第 1 行），给出 CSV 期望值 `48`；⑧ §6.1 补与 `工程规则.md` §4 精度门禁清单的逐项对账（裁判解析顺延 M2）；⑨ 更正 §1.5 数据流，显式画出「算子产分 → runner 回填 `passed` → 合并」两步，并新增 R-12 落地该分工；⑩ AC-6.11 扩为三组（阈值 0.5 / 0 / 缺省）以同时验证 `pass_rate` 的 `0.6` / `1.0` / `NULL` 三态；⑪ AC-7(a) 明确 `pass_rate = 0`（配了阈值但全部失败）而非 `NULL`，与 `score_overall = NULL` 形成「质量不可评 ≠ 可用性为零」的对照，D-10 的口径随之改准 |
| 2026-11-09 | 补录研发自检记录 | 追加 §9【研发自检记录】（见下），记录 7 个原子任务的完成情况、机械门禁实测数值、真栈联调结果与未验证范围 |

---

## 9. 【研发自检记录】

> 本节由研发侧在提交前填写，对应 §7「验收执行方式」的「研发侧自检」与「清除声明」。
> **「已通过」只对实跑过的检查项成立**；未跑的项目集中在 §9.4。

### 9.1 提交信息

| 项 | 值 |
|---|---|
| 分支 | `feat/m1-deterministic-eval-loop`（基线提交 `78e52e6 chore: 建立 M1 编码基线`） |
| 提交 | `223d71b08d1ddf8b5f57819cbcd9abb92e3d969c` —— `feat(M1): 核心底座与确定性评测闭环`（164 个文件，+29603 行）<br>紧随两个仅动工程设施的提交：`5be8e87`（更正 pre-commit 注释里的脚本期名）、`6099181`（把 `.githooks/pre-commit` 与 `enable-hooks.sh` 标记为 `100755`，否则在 Linux/macOS 上钩子会静默不执行）。**业务代码自 `223d71b` 起未再改动。** |
| 合并 | **未合并 `main`**。按本文件 §7「合并」一行，等待需求方明确授权 |

### 9.2 原子任务完成情况

| 任务 | 状态 | 主要交付物 |
|---|---|---|
| `[BE-01]` 数据库初始化迁移与种子评测集 | 完成 | `docker-compose.yml`、`db/migrations/0001…0018`（15 表 + 17 触发器 + 2 队列函数 + 0018 心跳租约）、`db/schema/`、`db/seed/`（fixture provider / 0 单价 / 20 条 RAG 基准集）、`tests/fixtures/cases-50.jsonl`、`tests/migrations.spec.ts`（`T-01`…`T-22`） |
| `[BE-02]` 确定性评测算子引擎与黄金精度单测 | 完成 | `lib/operators/`（六算子 + 工厂 + `requiresRetrieval` 一致性断言）、`composeCaseScore()`、各算子 ≥4 条边界用例（含 `IDCG=0 ⇒ 0 且有限`、`\|relevant\|=0 ⇒ 0`、`numeric_fidelity(missingFails)` 返回 `passed: null`） |
| `[BE-03]` 评测集 API 与 EvalRun 执行 / 汇总 API | 完成 | `db/repo/`（SQL 仅此层）、`app/api/*` Route Handlers（`runtime='nodejs'`）、`worker/loop.ts`（`claimNextRun → processRun → finalizeRun`，`pLimit`，SIGTERM 优雅退出）、`lib/gateway/`、`lib/import/`（JSONL/CSV，D-11 行号口径） |
| `[FE-01]` 工作台布局骨架 | 完成 | `tailwind.config.ts`（v3.4）+ `globals.css` 全量 Token、`components.json`、`@fontsource` 本地字体（无 `next/font/google`）、`components/shell/`（220/56px 侧栏 + 48px 顶栏）、`DataTable` / `EmptyState` / `Skeleton` / `StatusBadge`、ESLint `AS-1`/`AS-2` + `import/no-restricted-paths` + stylelint `color-no-hex` + `check:tokens` |
| `[FE-02]` 评测集（`PG-05`）与待测目标（`PG-06`） | 完成 | `/datasets` 列表 + 上传面板 + 逐行错误文案「第 47 行：缺少 case_key 且 input 为空」+ 版本历史内联预览 + 不可变文案；`/targets` 列表 + T1 表单（T2 置灰「P1 支持」）+ 版本语义文案 |
| `[FE-03]` 概览台（`PG-01`）/ 向导（`PG-02`）/ 运行详情（`PG-03`+`PG-04`） | 完成 | `/runs` 列表与空状态原文文案、未配凭证横幅、`/runs/new` 4 步向导（第 3 步仅规则算子区块）、`/runs/[runId]` 元数据栏含「EvalRun 可解释，不可复现。」、`primaryMetricOf()`（`FAILED` 时 `coverage` 提主位）、`<LiveRunProgressBar />`（`PENDING` 显示「等待调度」）、2s 轮询（终态停、`document.hidden` 暂停）、`PG-04` 单栏抽屉（仅「关闭」+ `Esc` + 焦点归还，不写 URL） |
| `[INT-01]` 前后端真栈联调 | 完成 | `npm run dev:all`（`scripts/dev-all.ts`）、`docs/Spec/M1-验收记录.md`、`npm run e2e` / `npm run e2e:fail`、静态扫描证据（见验收记录 §5） |

### 9.3 机械门禁实测

| 门禁 | 命令 | 实测结果 |
|---|---|---|
| 类型（应用） | `npx tsc --noEmit` | 无输出（0 错误） |
| 类型（契约） | `npm run typecheck -w @eval-platform/contracts` | `tsc --noEmit` 无输出（0 错误） |
| 静态检查 | `npx eslint . --max-warnings=0` | 无输出（0 错误 0 警告） |
| 单测 + 真库集成 | `npx vitest run` | **22 个测试文件全通过，343 条用例全通过，0 失败**（多次执行耗时 54–72s） |
| 样式 Token | `npm run check:tokens` | 通过（见 `tests/check-tokens.spec.ts` 16 条） |
| 样式规范 | `npm run lint:css` | 通过（见 `tests/stylelint-gate.spec.ts` 6 条） |

其中真库集成切片（连 `127.0.0.1:5433` 的真实 PG 16）覆盖：`tests/migrations.spec.ts`（`T-01`…`T-22`）、
`tests/api.spec.ts`（L2 Route Handler ↔ DB）、`tests/seed.spec.ts`、`tests/import.spec.ts`、`tests/queue.spec.ts`（`claim_next_run` 5 条）。

### 9.4 未验证范围（如实列出，不写「应该没问题」）

| 项 | 原因 |
|---|---|
| 浏览器真实交互（`PG-03` 进度条位宽不抖 / 终态停轮询、`PG-04` `Esc` 关闭 + 焦点归还、刷新后抽屉关闭） | 本轮联调用 HTTP 驱动真实接口，未接管真实浏览器做交互录制；页面 SSR 渲染已确认 HTTP 200，但上述四条属交互层行为 |
| 截图 | `M1-验收记录.md` 只保留终端输出与 SQL 结果，未附截图 |
| `next build`（生产构建） | 未执行；本轮 Next 验证止于 `next dev` |
| 真实模型网关 / 真实计价 | M1 设计即为零成本（fixture 单价 0，见 §6.3）；成本口径由 `computeCost()` 单测与 `T-11` 覆盖，M2 起用真实单价验证 |
| 并发 > `WORKER_CONCURRENCY`（4）的压力与长跑稳定性 | 未做压测；50 条夹具在本机 1s 内跑完 |
| 多进程 worker 竞争同一队列 | `claim_next_run()` 使用 `FOR UPDATE SKIP LOCKED`，`tests/queue.spec.ts` 覆盖了串行的领取/空队列/FIFO，但未起两个 worker 进程做并发争抢测试 |

### 9.5 联调中发现并修复的真缺陷（详见 `M1-验收记录.md` §0.1）

| # | 缺陷 | 为什么单测没抓到 | 修复与防回归 |
|---|---|---|---|
| 1 | `claim_next_run()` 声明为 `RETURNS eval_runs`（**复合类型**）：无行可领时 PL/pgSQL `RETURN r`（全 NULL）在 `SELECT * FROM fn()` 里**仍是一行**，`queryOne()` 判不出空 ⇒ worker 以 200ms 节奏无限刷 `领取 run null` | 单元测试直接测 `claimNextRun()` 的返回值，绕过了「SQL 层到底返回几行」 | 改 `RETURNS SETOF eval_runs` + `IF r.id IS NULL THEN RETURN;`；新增 `tests/queue.spec.ts` 5 条，其中一条**直接断言 `SELECT * FROM claim_next_run()` 零行** |
| 2 | 所有 API 路由 500：`Module not found: Can't resolve './common.js'`（源自 `contracts/src/index.ts`） | 仓库内部导入一律写 `.js` 后缀（磁盘上是 `.ts`）；vitest（vite）原生做这层映射，webpack 不做，所以测试与 typecheck 全绿 | `next.config.ts` 增加 `config.resolve.extensionAlias`（`.js → ['.ts','.tsx','.js']`） |

这两条都只有把 dev server 真跑起来才会暴露 —— 也是 §3 `[INT-01]`「严禁 Mock」这条设计要求的直接价值。

---

## 10. 【独立验收记录】M1 独立测试验收（2026-11-09）

> **阅读须知**：以下判定为 **2026-11-09 当轮原始记录**，原样保留、不改写；
> **2026-11-10 复核结论以各条下的「→ 复核」行为准**。
> 因此若同一条里出现 ❌/⚠️ 原文与 ✅ 复核并存，**以「→ 复核」行为最终口径** ——
> 原判定只用于还原当轮的现场，不代表当前状态。

> 验收对象：`src/` 工作树当前实际内容。当前分支 `feat/m1-deterministic-eval-loop`，HEAD `6099181d438903329efa5fa3f51573eb9f27e241`。
> **重要**：工作树存在未提交改动（7 个已跟踪文件修改，13 个未跟踪文件/目录），因此本记录不能等同于“固定 Commit 已交付”的证明；以下结果均是“当前工作树 + 当前运行实例”的真实读数。

### 10.1 结论

**❌ M1 独立验收未通过，禁止合并回 `main`。**

阻塞原因不是单一小问题，而是同时存在：
1. L3 页面客户端 bundle/CSS 运行态破损，核心向导无法继续；
2. 新增心跳租约测试 3/3 失败，并污染共享数据库；
3. 契约编译声明未按要求删除，M1 范围与迁移口径出现漂移；
4. 真实测试数据库中版本声明 `case_count` 与实际 `dataset_cases` 不一致；
5. `npm run dev:all` 无法稳定复跑（本轮独立启动报 `ENOMEM`）。

### 10.2 L1 机械门禁（真实命令与结果）

| 门禁 | 命令 | 实测结果 | 判定 |
|---|---|---|---|
| 类型检查（应用 + 契约） | `npm run typecheck` | 0 错误，退出码 0 | ✅ |
| ESLint | `npm run lint` | 0 错误 / 0 警告，退出码 0 | ✅ |
| Stylelint | `npm run lint:css` | 退出码 0 | ✅ |
| Token 静态扫描 | `npm run check:tokens` | `[check:tokens] 通过：77 个文件，无裸色值 / 渐变 / 内联样式。` | ✅（静态） |
| 全量测试 | `npm run test` | **26 个测试文件：25 通过 / 1 失败；372 条用例：369 通过 / 3 失败；耗时 223.67s** | ❌ |

失败明细（`tests/heartbeat-worker.spec.ts`）：

- `H-10/H-11 心跳持续时另一个 worker 不得回收`：`超时 45000ms 未等到：run COMPLETED`
- `H-11 心跳停止后另一 worker 可回收并续跑`：`超时 15000ms 未等到：A 领取 run`
- `H-12 运行中 succeeded_cases 递增`：`超时 90000ms 未等到：run COMPLETED`

这不是“断言数值不匹配”，而是 worker 在测试窗口内没有完成领取/执行，属于执行链路阻塞。新增用例的 `beforeAll` 会 `dropAndRecreateSchema` 共享数据库，`afterAll` 仅重建 schema 而不恢复业务种子；失败后实测留下：
- `eval_runs` 2 条 `RUNNING`
- `dataset_versions` 2 条，`case_count=1`
- `dataset_cases` 0 条
- `run_evaluators` 0 条
- `eval_case_results` 0 条

### 10.3 L2 数据库与 HTTP 真栈切片

#### 10.3.1 数据库状态

使用 `psql` 直连 `127.0.0.1:5433/eval_platform` 实测：

- `schema_migrations` 已应用 **18** 个迁移（含 `0018_heartbeat_lease.sql`）。
  （本轮当时记有「SPEC §1.1/§4 AC-1 仍写 17 个」的口径不一致；2026-11-10 已按裁定 `Q2 = A`
  批准 0018 纳入 M1，SPEC 四处口径同步为 18，该不一致已消除。）
- 15 张业务表均存在（`pg_tables` 16 行含 `schema_migrations`）。
- `model_providers`：2 行，`base_url` 2 行均为 `NULL`。
- `model_prices`：0 行。
- `dataset_versions`：2 行，声明 `case_count` 合计 2；`dataset_cases` 实际 0 行。
- `targets`：2 行，`current_version_no=0`，`target_versions` 实际存在 2 行（v1）——`targets.current_version_no` 与版本表状态不一致。
- `eval_runs`：2 行 `RUNNING`，均无 `run_evaluators` / `eval_case_results`。

**结论**：当前数据库不是可交付的干净真栈状态；测试失败后的清理没有恢复一致性。

#### 10.3.2 非法参数与错误处理（真实 HTTP）

| 请求 | 实测 | 判定 |
|---|---|---|
| `POST /api/datasets` 空/仅名称创建 | `201`，返回合法 Dataset | ✅ |
| `POST /api/datasets` name 超 120 字符 | `400 VALIDATION_FAILED`，`details.issues[0].path=name` | ✅ |
| `POST /api/datasets/imports/validate` 坏 JSONL（首行非法 JSON） | `200`，`okCount=0`、`failedCount=1`、`issues[0].line=1`、`canCommit=false` | ✅（格式错误被捕获） |
| `POST /api/targets` 提交 `t2_http` | `400 VALIDATION_FAILED`，`t2Enabled=false` | ✅（T2 P1 拦截） |
| `GET /api/datasets?limit=5` | `200`，返回数据集列表 | ✅ |
| `GET /api/providers` | `200`，只含 `apiKeyMasked`，未返回密文/明文 | ✅（本切片） |

未通过的 L2 机会：由于 `model_prices=0`、`model_providers.base_url=NULL`，无法用当前运行实例完成“数据集 → 目标 → 执行 → 结果落库”的完整评测闭环。现有 `api.spec.ts` 的 18 条用例通过，但它直接调用 Route Handler 并使用测试自造 schema，不覆盖当前 3000 实例的实际数据库状态。

### 10.4 L3 Playwright + Chrome DevTools 真机验收

#### 10.4.1 浏览器实测结果

使用 `playwright` MCP 与 `chrome-devtools` MCP 打开 `http://127.0.0.1:3000`：

| 页面 | 首屏 HTTP | 真实浏览器观察 | 判定 |
|---|---:|---|---|
| `/datasets` | 200 | HTML 可渲染；`/api/datasets` 手动 fetch 返回 3 条，但页面仍显示“（还没有评测集）”；表格 0 行 | ❌ |
| `/targets` | 200 | `/api/providers` 和 `/api/targets` 手动 fetch 均有数据，但下拉只有“还没有厂商”、目标表 0 行、保存按钮禁用 | ❌ |
| `/runs/new` | 200 | 只停在步骤 1；评测集下拉为空，`下一步` 永久禁用 | ❌（无法进入步骤 2/3/4） |
| `/runs` | 200 | 空壳，无表格数据 | ❌ |

#### 10.4.2 Console / Network

Chrome DevTools MCP 与 Playwright 均记录到持续 404：

- `/_next/static/css/app/layout.css?...` → `404`
- `/_next/static/chunks/main-app.js?...` → `404`
- `/_next/static/chunks/app-pages-internals.js` → `404`
- 部分页面 chunk（例如 `app/runs/page.js`）在旧实例中 → `404`
- `favicon.ico` → `404`

Playwright 最终累计 **14 Console Errors、0 Warnings**；Console 原文为 `Failed to load resource: ... 404 (Not Found)`。页面 `document.styleSheets` 中 `layout.css` 的规则数为 0，说明 CSS 实际未生效。

#### 10.4.3 视觉与 DESIGN 核对

- 静态源码：`app/globals.css` 存在 `.num { font-variant-numeric: tabular-nums slashed-zero; }`，`DataTable` 的 `numeric` 列会右对齐并加 `.num`。
- 运行时：CSS 未加载，`getComputedStyle` 抽样显示 `fontVariantNumeric = "normal"`、表格实际 0 行；因此**不能声称表格指标列已实现等宽数字对齐**。
- 徽章、语义色、布局溢出：运行时 CSS 缺失，无法完成 DESIGN §2/§3/§8 的有效验收；本轮只能确认静态 Token 扫描通过，不能确认视觉还原通过。

#### 10.4.4 截图证据

本轮新增：
- `src/docs/Spec/screenshots/independent-runs-new-current.png`
- `src/docs/Spec/screenshots/independent-targets-current.png`

既有截图（`pg03-*`、`pg04-*`）来自开发侧运行，不能替代本轮独立浏览器证据。

### 10.5 SPEC 任务与 AC 对账

| 项 | 对账结果 |
|---|---|
| `[BE-01]` 15 表 + 迁移 | ⚠️ 18 个迁移已落地，但 SPEC 仍冻结 17 个；触发器测试通过 17 个<br>→ **2026-11-10 复核**：`0018` 已按裁定 `Q2 = A` 批准纳入，SPEC §1.1/§4 AC-1 已同步为 18；本条已消解 |
| `[BE-02]` 六算子 | ✅ `operators.spec.ts` 38 条通过；`recall_at_k` / nDCG 边界在测试中覆盖 |
| `[BE-03]` API / Run 执行 | ⚠️ 测试内 API 用例通过，但真实数据库执行链路与 worker 测试失败 |
| `[FE-01]` 布局 / Token | ⚠️ 静态 Lint/Token 通过，运行时 CSS 缺失，视觉不可验收 |
| `[FE-02]` 数据集 / 目标 | ❌ 浏览器页面不消费 API 数据，目标下拉为空、保存禁用 |
| `[FE-03]` 概览 / 向导 / 详情 | ❌ 向导停在步骤 1，无法发起评测；运行详情未完成真实闭环 |
| `[INT-01]` 真栈联调 | ❌ 当前实例不能复跑 `dev:all`，页面与 API 不一致，核心闭环未通过 |
| AC-1 迁移/不可变 | ✅ `migrations.spec.ts` 23 条通过（含 T-01…T-22）；但口径与 SPEC 迁移数不一致 |
| AC-2/AC-3 导入 | ✅ 测试内 50 条与 47/48 行号断言通过；坏 JSONL 实测行号正确 |
| AC-4/AC-5 算子 | ✅ 对应单测通过 |
| AC-6 50 条跑批 | ⚠️ API 测试通过；新增 worker 真进程测试失败，当前真实实例无法复现 |
| AC-7 失败/中断 | ⚠️ 网关失败路径在 API 测试中通过；H-11 中断/回收测试失败 |
| AC-8 无 Mock | ❌ 页面表现为静态空壳，且页面与 API 数据不一致；无法证明所有页面数据可追溯到 `/api/*` 响应 |

### 10.6 契约与单一事实源检查

| 检查项 | 结果 |
|---|---|
| `src/contracts/README.md` 编译状态声明 | ❌ 仍存在“未执行编译验证 / 业务代码不得依赖”声明；SPEC-M1 要求本里程碑删除<br>→ **2026-11-10 复核**：过期声明已删除，契约已通过 `npm run typecheck -w @eval-platform/contracts`；本条已消解 |
| 契约文件只读 | ❌ 工作树修改了 `contracts/src/db-schema.ts`（新增 0018 到 `CROSS_CUTTING_MIGRATIONS`），与 SPEC §1.2“不得新增/修改契约文件”冲突<br>→ **2026-11-10 复核**：按裁定 `Q2 = A` 认定为**登记同步**（迁移清单登记表，非契约变更），并已在 SPEC §1.2 写明唯一例外；本条已消解 |
| 迁移事实源同步 | ⚠️ `docs/facts/database-schema.md` 已同步 0018/心跳租约，但 `SPEC-M1` 仍写 17 个迁移；同一事实存在两个口径<br>→ **2026-11-10 复核**：SPEC §1.1/§4 AC-1/§10.3/§10.5 已统一为 18 个迁移；本条已消解 |
| 时间格式 | ✅ API 样本均为 ISO 8601（如 `2026-11-09T11:14:09.392Z`） |
| 分页结构 | ✅ 样本均返回 `{ items, page: { nextCursor, total } }` |
| 小数位/百分比 | ⚠️ 静态格式化函数存在，但因页面未加载数据，无法做运行时全局一致性证明 |

### 10.7 安全与横切扫描

- **API Key 脱敏**：`GET /api/providers` 实测只返回 `apiKeyMasked`，未返回 `api_key_ciphertext` 或明文；`listProviderViews()` 显式不 select 密文。✅（限该路径）
- **SQL 参数化**：`db/repo/*` 的查询使用 `$1`/`$2` 参数绑定，静态扫描未发现直接拼接用户输入的高置信 SQL 注入。✅（静态）
- **危险 HTML**：仅 `app/layout.tsx` 使用 `dangerouslySetInnerHTML` 注入固定主题启动脚本，未使用用户输入。✅
- **未完成**：由于真实页面 bundle 破损，无法在浏览器层面验证 XSS、越权参数组合与所有 API 的运行时脱敏；本轮不声称“安全全通过”。

### 10.8 阻塞合并缺陷清单

| # | 严重度 | 缺陷 | 复现步骤 | 修复建议 |
|---|---|---|---|---|
| B-01 | **P0** | 页面静态资源 404，客户端 bundle/CSS 不完整 | 启动 3000 后访问 `/runs`、`/datasets`、`/targets`、`/runs/new`；Chrome DevTools 观察 `layout.css`、`main-app.js`、`app-pages-internals.js` 404，Console 14 Errors | 先修复 dev server/Next 构建产物一致性；重启前清理 `.next` 并确认 `npm run dev:all` 从干净状态启动；补一条浏览器级 smoke test<br>→ **2026-11-10 复核**：根因是 `.next` 混合 prod/dev 产物；已落地 `prebuild`/`clean:next` 门禁与浏览器对账脚本（工程规则 §4.0）。**开发侧已修复，待独立验收复核** |
| B-02 | **P0** | 页面不消费 API 数据：`/datasets`、`/targets`、`/runs/new` 显示空数据 | 手动 fetch `/api/datasets` 有 3 条、`/api/providers` 有 2 条，但页面显示“还没有评测集/厂商”，向导下一步禁用 | 修复 `useApi` hydration/错误态；页面加载失败必须显示明确错误而不是伪装成空状态；补页面-API 对照 E2E<br>→ **2026-11-10 复核**：与 B-01 同根（chunk 404 ⇒ 不水合），非 `useApi` 缺陷；已补“API N 条 ⇒ 表格 N 行”断言。**开发侧已修复，待独立验收复核** |
| B-03 | **P0** | 心跳租约真进程测试 3/3 失败，worker 不领取/不完成 | `npm run test`，观察 `tests/heartbeat-worker.spec.ts` 三个超时 | 修复 worker 启动/领取/心跳/终结链路；测试应输出子进程 stderr；确保 `afterAll` 恢复种子与 schema<br>→ **2026-11-10 复核**：根因是测试与常驻 worker 共用 `eval_platform` 库（工程规则 §4.2）；断言一个字未改。**开发侧已修复，待独立验收复核** |
| B-04 | **P0** | 测试共享数据库污染且遗留不一致数据 | 运行全量测试后执行 `psql` 查询：2 个 `RUNNING` run、`dataset_versions.case_count=2`、`dataset_cases=0`、`model_prices=0` | 使用独立测试库/schema（如 `eval_platform_test`）或在 `afterAll` 完整恢复种子；禁止测试直接破坏共享演示库<br>→ **2026-11-10 复核**：已隔离到独立 database `eval_platform_test`（工程规则 §4.2）。**开发侧已修复，待独立验收复核** |
| B-05 | **P0** | 契约编译声明未删除，且修改了只读契约 | 检查 `contracts/README.md` 仍写“未执行编译验证/业务代码不得依赖”；`git diff` 显示 `contracts/src/db-schema.ts` 被修改 | 删除声明并同步所有契约注释；按 SPEC 将 0018 变更先登记/批准，或回退契约改动并在正确事实源处理<br>→ **2026-11-10 复核**：过期声明已删除；0018 登记按裁定 `Q2 = A` 认定为登记同步（见 §1.2）。**开发侧已修复，待独立验收复核** |
| B-06 | **P1** | SPEC 冻结 17 个迁移，实际 18 个；事实文档与 SPEC 不一致 | `rg -n "0018|17 个迁移|18" docs/Spec/SPEC-M1.md docs/facts/database-schema.md` | 由需求方确认 0018 是否纳入 M1；若纳入，更新 SPEC 的迁移清单、AC-1 与验收记录；若不纳入，移除 0018 并回退依赖<br>→ **2026-11-10 复核**：裁定 `Q2 = A` 纳入；SPEC §1.1/§4 AC-1/§10.3/§10.5 已同步为 18。**开发侧已修复，待独立验收复核** |
| B-07 | **P1** | 真实数据库中 provider 无 `base_url`、无 `model_prices`，无法执行真实评测 | `psql` 查 `model_providers`/`model_prices`；`POST /api/runs` 前 preflight 或 worker 会缺执行配置 | 恢复/修复 `db:seed` 幂等种子；在干净库执行 `migrate → seed → target → run` 并断言价格、base_url、版本、case 行全部一致<br>→ **2026-11-10 复核**：dev 库已复原为「只有种子」（20 条 case、`base_url` 非空）。**开发侧已修复，待独立验收复核** |
| B-08 | **P1** | `targets.current_version_no=0` 但 `target_versions` 有 v1；`dataset_versions.case_count` 与实际 case 数不一致 | 用 psql 查询 `targets`/`target_versions`、`dataset_versions`/`dataset_cases` | 修复测试 fixture 事务与聚合一致性；为“声明计数必须等于实际行数”增加数据库级回归测试<br>→ **2026-11-10 复核**：夹具已守不变量 + `restoreSeed()` 收尾，新增 `tests/seed-integrity.spec.ts` 数据库级回归（工程规则 §4.3）。**开发侧已修复，待独立验收复核** |

### 10.9 未验证范围（不得当作通过）

- 真实浏览器完成“导入 → 创建目标 → 4 步向导 → 跑批 → 报告 → 抽屉”闭环：**未完成**，因 B-01/B-02/B-03 阻断。
- 断网/上游超时/429/损坏 JSONL 的完整 worker 级韧性：仅坏 JSONL 与 T2 边界有实测；worker 超时/回收路径失败。
- SSE：M1 明确不要求，未纳入本轮通过判定。
- 真实 `next build`：未执行；本轮仅验证 `next dev`。
- 颜色对比度/色盲分离度：静态 Token 与 Lint 通过，运行时 CSS 失效，V-1/V-2 仍不得声称通过。
- 合并授权：**未申请、未执行**。按 AGENTS.md 与工程规则，合并必须等待需求方明确授权；本轮结论为停止合并、交回开发修复。

### 10.10 复现证据索引

- L1：`npm run typecheck`、`npm run lint`、`npm run lint:css`、`npm run check:tokens`、`npm run test`
- L2：`psql` 直连查询（18 个迁移、15 表、provider/price/version/case 计数）；真实 HTTP 边界测试（400/200/201）
- L3：Playwright MCP 页面快照与点击；Chrome DevTools MCP Console/Network；截图 `independent-runs-new-current.png`、`independent-targets-current.png`
- 运行环境阻断：独立启动 `npm run dev:all` 报 `SystemError [ERR_SYSTEM_ERROR]: uv_os_get_passwd returned ENOMEM`，因此无法用新实例复核；该阻断已计入 B-01/B-03 的复现风险，不单独当作业务缺陷，但不能据此宣布环境无关。

