# 技术方案

> **本文件是「架构选型 / 并发与推流 / 成本口径 / 评分解算规则」的唯一事实源。**
> 产品定位与角色见 [`product-overview.md`](./product-overview.md)；
> 故事见 [`user-stories.md`](./user-stories.md)；页面见 [`pages-and-flows.md`](./pages-and-flows.md)；
> 表结构见 [`database-schema.md`](./database-schema.md)。
> 规则依据：`docs/工程规则.md` 第 1 节「单一事实源原则」。
>
> 建立日期：2026-11-07 · 状态：**已确认**（Step 6–7，需求方拍板 Q1–Q6）

---

## 0. 一句话架构

**单运行时 TypeScript 全栈 + Postgres 原生队列 + 独立 worker 进程 + LiteLLM sidecar 路由，Docker 自托管。**

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js 15 (App Router, nodejs runtime)                     │
│  ├─ RSC / 页面（PG-01…PG-10）                                 │
│  └─ Route Handlers  ── REST + SSE ──┐                        │
│         │                            │                        │
│         │ Drizzle ORM                │ LISTEN/NOTIFY          │
│         ▼                            ▼                        │
│  ┌─────────────────────────────────────────────┐             │
│  │  PostgreSQL 16                              │             │
│  │  ├─ 业务表（15 张）                          │             │
│  │  ├─ 任务队列（SKIP LOCKED）                  │             │
│  │  └─ 不可变触发器                             │             │
│  └─────────────────────────────────────────────┘             │
│         ▲                                                     │
│         │ 领取任务 / 回写结果                                  │
│  ┌──────┴──────────────────────────┐                          │
│  │  Worker 进程 (node, 常驻)        │                          │
│  │  • 并发跑批 (p-limit)            │                          │
│  │  • 算子计算 (规则 + 裁判)        │                          │
│  │  • 成本计算（读我方单价表）       │                          │
│  └──────┬──────────────────────────┘                          │
└─────────┼────────────────────────────────────────────────────┘
          │ HTTP (OpenAI 兼容)
          ▼
   ┌─────────────────┐
   │ LiteLLM Proxy   │  ← sidecar，只做路由 / 重试 / 限流
   │ (独立进程)       │     不用它的成本统计
   └────────┬────────┘
            ▼
      厂商模型 API
```

---

## 0.5 部署前提（已确认 · 本轮新增，约束所有选型）

| 约束 | 具体要求 | 对选型的硬影响 |
|---|---|---|
| 部署形态 | **本地 / 内网一键拉起**（`docker compose up` 即完整可用） | 必须有 Docker 自托管路径；**排除 Vercel / Cloudflare 等 Serverless**（见 TS-3 部署约束） |
| 网络可用性 | 国内网络可顺畅访问，**内网离线可用** | 全部依赖走 npm 私有镜像 / 预先 `npm ci` 打包进镜像；**构建期不得联网拉取运行时资源** |
| 禁止项 | **不依赖任何 Google 专有在线服务** | `next/font/google` 一律禁用（构建期联网）；Google Analytics / reCAPTCHA / Google Charts 全部不用 |
| 字体 | 系统字体栈（见 TS-5） | 不打包字体文件，避免体积与许可问题 |
| 图标 | Lucide 本地 SVG 组件（见 TS-5） | 不引 Font Awesome CDN / Iconfont 在线脚本 |
| 图表 | ECharts 本地包（见 TS-5） | 不用 Google Charts / 任何 CDN 版图表库 |
| 模型网关 | LiteLLM sidecar 随 compose 一起起 | 厂商 API 走内网可达的 Base URL，**不假设能直连境外端点** |

> 一句话：**整套系统在断网的机器上 `docker compose up` 必须能跑通全流程**（厂商模型除外 —— 它本来就是外部依赖，且通过可配置 Base URL 指向内网代理）。

---

## 1. 五项技术选型（已确认）

### TS-1 · 应用主框架语言

| | |
|---|---|
| **定稿** | **全 TypeScript**：Next.js 15（App Router）+ 独立 Node worker |
| 备选（已否决） | A. Next.js + FastAPI 双服务　B. 全 Python |

**决策依据**：6 个算子全部是数组/字符串/浮点运算或单次 HTTP 调用，**无一需要 Python 数值生态**；跑批是 I/O 密集而非 CPU 密集，Node 事件循环适配；单运行时避免依赖锁、CI、SSE 代理、**双份类型契约漂移**四重成本（与 `工程规则` §3「契约先行」相悖）。

**已知短板（红队留档，不隐藏）**：
1. 本地语义相似度 / embedding 类算子会吃力；
2. CSV/JSONL 脏数据清洗鲁棒性弱于 `pandas`；
3. 若将来必须双运行时，成本是四件事同时翻倍。

#### TS-1 触发条件（已确认，写死）

> **一旦要引入语义相似度算子（如 BERTScore、批量余弦相似度）或需要 pandas 级别的脏数据清洗能力，必须新增 Python sidecar，不得用 TS 硬凑。**
>
> 触发时必须：
> 1. 在 `docs/facts/technical-solution.md` 记录触发原因与日期；
> 2. sidecar 通过 HTTP 契约暴露能力，**契约落在 `src/contracts/`**，不得隐式耦合；
> 3. 更新本文件 §1 与本表。

---

### TS-2 · 多模型路由层

| | |
|---|---|
| **定稿** | **LiteLLM Proxy 作为 sidecar**（独立进程，OpenAI 兼容 `/v1/chat/completions`） |
| 备选（已否决） | A. 自写薄网关　B. Vercel AI SDK 进程内多 provider |

**决策依据**：LiteLLM 是**独立进程、只走 HTTP**，把"多厂商路由"从语言选型中解耦；自带重试、fallback、并发限流、token 计数，自写必出 bug。

#### 🔒 成本口径红线（已确认，不可协商）

> **我方数据库的 `model_prices` 表是唯一成本事实源。**
>
> - LiteLLM **只负责路由与限流**；
> - **绝不读取、绝不落库、绝不展示 LiteLLM 自带的成本统计**；
> - 所有成本由我方按 `tokens_in/out × model_prices 单价` 自行计算并写入 `eval_case_results` / `eval_runs`。

**已知短板**：多一个 Python 服务要部署与打补丁（CVE 响应义务）；它挂掉会导致整批 `FAILED`（成功数 0），错误栈在另一进程，排查链路变长；`config.yaml` schema 跨小版本漂移。

---

### TS-3 · 并发调度与 SSE 推流

| | |
|---|---|
| **定稿** | Postgres 做队列（`SELECT … FOR UPDATE SKIP LOCKED`）+ 独立 worker + `LISTEN/NOTIFY` 驱动 SSE fan-out |
| 备选（已否决） | A. Redis + BullMQ　B. 进程内 `p-limit` 无持久队列 |

**决策依据**：不引入新基础设施；`SKIP LOCKED` 原生支持多 worker 水平扩展且不重复消费，满足「重启后续跑」韧性要求；`NOTIFY` 把推送延迟从轮询秒级降到毫秒级。

#### 🔒 部署约束（已确认）

> **SSE 长连接 + 常驻 worker 决定：必须 Docker 自托管，不得部署到 Vercel Serverless。**
> Next.js Route Handler 必须声明 `export const runtime = 'nodejs'` 且禁用静态化。

#### 🔒 SSE 韧性条款（必须写进 SPEC 验收）

> **前端断线重连后，必须先拉一次全量快照（`GET /api/runs/:id`），再续订 `/api/runs/:id/stream`。**
> **不允许只依赖增量事件** —— `NOTIFY` 不保证投递，进程断开期间的通知直接丢失。

**已知短板**：
1. `SKIP LOCKED` 需短轮询间隔（约 200ms），空转有浪费；
2. `NOTIFY` payload 上限 **8000 字节**，Case 输出大时只能传 ID 再回查（多一次往返）；
3. 单实例部署时 PG 通知扇出是单点（首版可用，多实例需改造）。

---

### TS-4 · 数据库存储

| | |
|---|---|
| **定稿** | **Postgres 16+ + Drizzle ORM**（`jsonb` 存配置与输出，`numeric` 存分数与金额） |
| 备选（已否决） | A. Prisma　B. SQLite |

**决策依据**：核心查询是重聚合类（`percentile_cont` 算 P50/P95、`case_key` 全外连接逐条对比、台账多维 `GROUP BY`）；Drizzle 的 `sql` 模板既保类型又能写原生 SQL。**`numeric` 而非 `float` 是硬要求** —— 金额与分数不得有浮点误差。

**已知短板**：
1. `drizzle-kit` 迁移弱于 Prisma，复杂改表需手改 SQL，必须 review 每个迁移文件；
2. 无开箱关联查询，多表 join 要自己写；
3. **触发器在 Drizzle DSL 中表达不了**，必须手写迁移 SQL → `src/contracts/` 的 schema 与真实 DDL **存在漂移风险**，必须在迁移测试中断言触发器存在。
4. SQLite 被否：不支持 `SKIP LOCKED` / `percentile_cont` / 部分唯一索引，与本设计三根支柱直接冲突。

---

### TS-5 · 前端 UI 组件栈

| | |
|---|---|
| **定稿** | Next.js 15 App Router + **shadcn/ui** + Tailwind CSS Variables + **TanStack Table `^8`（锁 v8，禁止 v9）** + TanStack Query |
| 备选（已否决） | A. AG Grid　B. MUI DataGrid |

#### 图表与图标（2026-11-07 补充定稿，全部开源 + 可离线打包）

| 用途 | 选型 | 为什么不是别的 |
|---|---|---|
| 雷达图 / 分差图（PG-08、PG-03） | **ECharts 5**（`echarts` + 按需 `echarts/core`） | 内置雷达、箱线、`markLine` 阈值线；纯本地包，无 CDN 依赖。Recharts 的雷达图太薄，D3 要实现题面标注等于自建库 |
| 图标 | **Lucide Icons**（`lucide-react`） | 本地 SVG 组件，不请求任何在线字体服务；与 shadcn/ui 同源，风格统一 |
| 字体 | **系统字体栈**（`-apple-system` / `Segoe UI` / `PingFang SC` / `Microsoft YaHei`） | **不引入 Google Fonts**。`next/font/google` 会在构建期联网拉字体，在内网与国内网络均为单点故障 |

> **ECharts 的已知短板（红队留档）**：包体大（全量约 1MB，按需引入后可控），且它的主题体系与 Tailwind Token 是两套，
> 必须在 `lib/charts/theme.ts` 里把 Token 转成 ECharts `option` 一次，否则会有人直接在 `option` 里写裸 `#hex`（违反 `工程规则` §4）。
> **Lucide 的短板**：名称跨大版本会改（`AlertTriangle` → `TriangleAlert`），故锁 `lucide-react` 小版本并禁止深引 `lucide/dist`。

**决策依据**：`PG-03` 明细表需排序/筛选/行点击/虚拟滚动；TanStack Table 无头，样式完全受 Tailwind Token 控制，直接满足 `工程规则` §4「禁止裸写 `#hex`」。AG Grid / MUI 自带主题体系会与 Token 打架，最终必然硬编码色值。

**已知短板**：
1. 无头 =排序 UI、分页、空状态、骨架全要自己写，工作量 3–5 倍；
2. **shadcn/ui 是复制进仓库的代码不是依赖**，升级靠手动 diff；建在 Radix 之上，`PG-04` Drawer 的无障碍焦点问题要自己调；
3. **TanStack Table v9 已进 beta**，网络教程混用 v8/v9 API → **必须锁 `^8`**；
4. AG Grid 被否的真实理由不是贵，是主题系统会逼人放弃 Tailwind Token。

---

## 2. 评分解算规则（OPEN-1…OPEN-5 定稿）

> 本节决定数据库字段与 API 契约，**已全部确认**。

### OPEN-1 · 总分聚合（已确认）

```
Case 得分     = Σ(算子得分 × 算子权重) / Σ(算子权重)          ← 权重默认 1
EvalRun 总分  = avg(Case 得分) WHERE status = 'OK'           ← 简单平均，不加权
```

**否决理由**：用通过率当总分丢失幅度信息；对 Case 加权需「Case 分组」新实体（无故事支撑）；按 token 加权会让答案啰嗦的模型虚高（反向激励）。

**已知局限**：简单平均会被简单 Case 稀释（困难子集退化 20% 可能只掉 2% 总分）。**这是设计选择**：总分只作粗粒度信号，决策依据是分算子指标与 `PG-08` 逐条对比。首版不做子集加权。

### OPEN-2 · 算子冲突裁决（已确认）

```
case.passed        = 所有算子均通过（AND）
case.score         = 加权归一后的连续分
operator_scores    = 完整保存每个算子的 score / passed / threshold / reason
```

**不设优先级**：任何"规则压裁判"或反过来，都是静默丢信息，且会长出新的配置面（谁压谁、什么条件下压）—— `OUT-4` 级复杂度。

**已知代价**：AND 语义严苛，`pass_rate` 可能长期偏低。**缓解**：`pass_rate` 不是决策主轴；`PG-04` 并列显示冲突（如「规则未通过 / 裁判 0.9」），**冲突本身是最有价值诊断信号** —— 通常意味着裁判 Prompt 有偏或参考答案有误。

### OPEN-3 · 裁判成本归属（已确认）

```
eval_runs:          cost_target / cost_judge / cost_total
eval_case_results:  cost_target / cost_judge / cost_total
```

**依据**：裁判常比被测模型更贵（长 Prompt + 待评答案 = 大输入）。混成一列就永远拆不开，而 `US-019` 台账恰恰要回答"钱花在哪"。

**实现约束**：`cost_total` 用 `GENERATED ALWAYS AS (COALESCE(cost_target,0) + COALESCE(cost_judge,0)) STORED`，聚合只查它；分列仅在 `PG-03` 与 `PG-10` 下钻时读。

### OPEN-4 · 可复现性（已确认 · 口径锁死）

```
eval_runs.reproducibility = {
  temperature, top_p, max_tokens, seed,
  runner_version, model_version_string,
  prompt_template_hash, cache_policy: "none"
}
```

#### 🔒 对外表述红线（锁死，不可改写）

> **「EvalRun 可解释，不可复现。」**
>
> 此句必须原样出现在：
> 1. 本文件；
> 2. `PG-03` 评测运行详情页的说明文案；
> 3. `docs/facts/DESIGN.md` 的文案规范。

**首版不做响应缓存。** 理由：LLM 本身不保证可复现（同 seed 同参数仍可能不同），宣称"可复现"是撒谎；而加缓存会制造更坏的假象（用户以为是新调用，实为命中旧结果），回归结论直接失真。

**已知代价**：调试期反复重跑会重复烧钱。**缓解**：由 `US-014`（中止）+ 并发上限 + "先小样本跑"承担成本控制职责，不靠会污染数据的手段。

### OPEN-5 · 失败分母（已确认）

```
score_overall = avg(score)  WHERE status = 'OK'      ← 质量
pass_rate     = passed / total_cases                 ← 可用性（失败计入分母，视为不通过）
coverage      = succeeded / total_cases              ← 完整性
succeeded = 0 → score_overall = NULL（不是 0），status = FAILED
```

**否决理由**：

| 单一口径 | 后果 |
|---|---|
| 失败不计入分母 | 跑挂一半的批次得到**虚高总分**（最危险的错误） |
| 失败视为 0 分并计入 | 模型质量与网络抖动混淆，无法判断该修 Prompt 还是修基建 |
| 只报通过率 | 丢失幅度信息 |

**UI 约束**：`score_overall` 大字号主指标；`pass_rate` / `coverage` 次级样式；**`FAILED` 状态下把 `coverage` 提到主位** —— 那时"为什么一条都没成"才是唯一有意义的问题。

---

## 3. 并发与流式执行设计

### 3.1 任务领取

```sql
UPDATE eval_runs SET status = 'RUNNING', started_at = now()
WHERE id = (
  SELECT id FROM eval_runs
  WHERE status = 'PENDING'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
) RETURNING *;
```

### 3.2 单次 EvalRun 内部

1. 读取 `dataset_cases`（该版本全部）→ 建立待执行列表；
2. `p-limit(concurrency)` 并发，每条：
   - 快照上下文（Target 版本、`run_evaluators`、`model_prices`）**已在建 run 时写入 `config_snapshot`**，执行期不再回查模板表；
   - 调 LiteLLM → 得输出 + token 用量；
   - 按 `run_evaluators.order_index` 依次计算各算子（规则算子本地算，裁判算子再调一次 LiteLLM）；
   - 按 `model_prices` 计算 `cost_target` / `cost_judge`；
   - 幂等写入 `eval_case_results`（`UNIQUE(eval_run_id, case_key)` 兜底）；
   - `NOTIFY run_progress, '<eval_run_id>'`。
3. 全部结束 → 聚合写入 `eval_runs` 汇总列 → 置终态。

### 3.3 终态判定

| 条件 | 状态 |
|---|---|
| 全部 `OK` | `COMPLETED` |
| 有失败且 `succeeded > 0` | `PARTIAL_FAILED` |
| `succeeded = 0` | `FAILED` |
| 收到 `cancel_requested_at` | `CANCELLED`（已完成结果保留） |

### 3.4 SSE 事件契约

见 `src/contracts/src/eval-contracts.ts`（对外名 `EvalProgressEvent`）与 `sse.ts`（判别联合 `RunStreamEvent`）。事件类型：

| `type` | 载荷 | 触发时机 |
|---|---|---|
| `snapshot` | 全量运行状态 + 已完成计数 | 连接建立 / 重连后首次 |
| `case` | 单条 CaseResult 摘要 | 每条完成 |
| `status` | 状态徽章变更 | 状态流转 |
| `heartbeat` | 时间戳 | 每 15s（保活） |
| `error` | 错误码与信息 | 运行异常 |

**重连语义**：客户端携带 `Last-Event-ID` → 服务端返回 `snapshot`（不做事件回放）。**首版不做事件回放**，快照即真相。

#### 关于 `Last-Event-ID` 断线续传（**已拍板：不做回放**）

需求方在「决策点 3」曾提出「EventBus 环形缓冲 + `Last-Event-ID` 补齐缺失事件」，与本节的「不做事件回放」**直接冲突**。**2026-11-07 需求方拍板：采纳 `snapshot_only`，不加环形缓冲。** 定稿状态与保留项如下：

- 契约层**已预留** `EvalProgressFrame.id`（形如 `<runId>:<单调序号>`）与解码函数，因此**将来加回放不是破坏性协议变更**；
- `PROGRESS_RESUME_POLICY.mode` **固定为 `snapshot_only`**，`replayImplemented: false`，`decisionRecord` 字段记录本次拍板；
- 若将来真要切到 `ring_buffer` 模式，必须先补齐三条（缺一不可）：**环形缓冲容量上界与淘汰规则** / **进程重启后回落 snapshot 的行为** / **`Last-Event-ID` 已被淘汰时补发 snapshot**。

> 红队结论（已被需求方采纳）：**回放是"锦上添花"，不是正确性前提**。缓冲在进程内存里，worker 重启即清空；`NOTIFY` 本身不保证投递。所以「断线后补齐」这件事在任何方案下最终都要回落到「拉快照」。加回放只减少一次快照往返，代价是一块有界内存 + 三条例外规则 + 一套测试。**若上线目标含"进程随时可被杀"，回放收益极小。**

---

## 3.5 链路一 · 异步并发跑批 + SSE 断线续传全过程

> 涉及页面：PG-01（发起）、PG-02（配置）、PG-03（实时进度）。涉及算子：`US-006`…`US-012`。

```
[1] POST /api/runs            ── 单一事务 ──────────────────────────────┐
    ├─ 校验 preflight（凭证/算子/检索标注）→ 不通过即 409 BLOCKED_*      │
    ├─ 读取 dataset_versions.content_hash（锁定快照，不再读 dataset_cases 正文决策）
    ├─ 快照 run_evaluators（模板 → 实例，此后模板改版不影响本 run）
    ├─ 快照 model_prices（按 effective_from ≤ now() 取生效单价）
    ├─ 写入 config_snapshot + reproducibility{cache_policy:'none'}
    └─ INSERT eval_runs(status='PENDING', total_cases=...)
                                          ▲ 提交后才有 run.id
[2] Worker: claim_next_run()              │  UPDATE ... FOR UPDATE SKIP LOCKED LIMIT 1
    ├─ 0 行 → sleep 200ms 再取（空转成本已知，见 TS-3 短板 1）
    └─ 1 行 → status='RUNNING', started_at=now()
[3] 逐条执行（p-limit(concurrency)，默认 4，上限 32）
    ├─ 网关调用（LiteLLM /v1/chat/completions）→ output + usage
    │    ├─ 429/5xx → 有限次指数退避；仍失败 → status='QUOTA_EXCEEDED'/'FAILED'，score=NULL
    │    └─ 超时 → status='TIMEOUT'，score=NULL        ← 绝不落 0 分
    ├─ 算子流水线（按 run_evaluators.order_index 串行）
    │    ├─ 规则算子：本地纯函数（EvaluatorOperator.score）
    │    └─ 裁判算子：再调一次网关 → 解析 → 解析失败 = 'PARSE_ERROR'
    ├─ composeCaseScore() → 加权均分 + AND 判定 + 冲突标记（OPEN-2 不仲裁）
    ├─ 按 model_prices 算 cost_target / cost_judge（cost_total 由 STORED 列生成）
    └─ INSERT eval_case_results（UNIQUE(eval_run_id, case_key) 兜底幂等）
         └─ 同一事务内 NOTIFY run_progress, '<runId>'   ← 事务提交后才真正投递
[4] 终态聚合（worker 收尾，单一事务）
    ├─ UPDATE eval_runs：三计数 + score_overall/pass_rate/coverage + P50/P95 + tokens + 成本
    │    └─ P50/P95 用 percentile_cont 在 DB 内算，不在 Node 里排序全量
    ├─ deriveTerminalStatus() → COMPLETED / PARTIAL_FAILED / FAILED / CANCELLED
    └─ status 落终态 ⇒ trg_eval_runs_guard 冻结整行
[5] SSE fan-out
    ├─ 服务端 LISTEN run_progress（独立连接，不能复用连接池 —— TS-3 待核验项）
    ├─ 收到 NOTIFY → 回查该 run 的增量计数 → 生成 case 事件 → fan-out 给订阅者
    └─ 每 15s 补 heartbeat（代理/浏览器判定连接存活）
[6] 客户端断线重连（当前最优解）
    ├─ 检测：30s 内无任何事件 ⇒ 视为死连接
    ├─ GET /api/runs/:id 拉全量快照（快照即真相）← 唯一可信的补齐手段
    └─ 重新订阅 /stream，丢弃 snapshot 之前的陈旧事件
```

### 异常矩阵（这段决定「跑批不丢状态」靠什么）

| 故障 | 结果 | 靠什么兜住 |
|---|---|---|
| 网关 5xx / 429 | 该条 `FAILED` / `QUOTA_EXCEEDED`，`score=NULL` | `ck_eval_case_results_ok_score` 禁止伪造 0 分 |
| worker 进程被杀 | 该 Run 停在 `RUNNING` | **心搏回收**：`reclaim_stale_runs()`（`database-schema.md` §4.1）把 `started_at` 超阈值的 `RUNNING` 行退回 `PENDING`，由 `ix_eval_runs_running_started` 支撑。**该函数必须被定时调度，否则形同不存在** |
| `NOTIFY` 丢失 | 前端少一条增量 | 重连先拉快照；`completedCount` 单调递增可自校验 |
| 并发重复消费 | 不会发生 | `SKIP LOCKED` + 状态机触发器双重拦截 |
| 客户端长时间离屏 | 事件全丢 | 回到页面即重拉快照 —— 这正是「不做回放」能成立的原因 |

> **红队自报的致命短板**：worker 崩溃后 `RUNNING` 行会成为僵尸任务（`SKIP LOCKED` 只领 `PENDING`）。
> 首版必须有回收任务（`reclaim_stale_runs()`，见 `database-schema.md` §4.1），否则「一键重启后任务永远卡在 99%」是必然发生的故障，不是概率问题。

---

## 3.6 链路二 · 双版本 AB 对比与 Badcase Diff 聚合

> 涉及页面：PG-08（报告对比）、PG-04（Case 抽屉）。涉及故事：`US-009` / `US-010` / `US-011`。

**对齐键**：`dataset_cases.case_key`（`ux_dataset_cases_version_key` 保证版本内唯一）。
**对齐前提**：两个 `eval_runs.dataset_version_id` 必须相同；不同则接口 400，不出表。

```sql
-- 单次查询完成对齐（不在 Node 里 join 两个数组 —— 300×2 行尚可，1 万行即爆内存）
WITH b AS (
  SELECT r.case_key, r.score, r.status, r.operator_scores
  FROM eval_case_results r WHERE r.eval_run_id = $baseline
), c AS (
  SELECT r.case_key, r.score, r.status, r.operator_scores
  FROM eval_case_results r WHERE r.eval_run_id = $current
)
SELECT COALESCE(b.case_key, c.case_key) AS case_key,
       b.score  AS baseline_score, c.score  AS current_score,
       b.status AS baseline_status, c.status AS current_status,
       b.operator_scores, c.operator_scores,
       (c.score - b.score) AS delta
FROM b FULL OUTER JOIN c USING (case_key)
ORDER BY case_key;
```

**为什么用 `FULL OUTER JOIN` 而不是 `INNER JOIN`**：`INNER` 会把「v2 新增的 Case」和「v1 独有、v2 被删的 Case」静默丢掉，
退化率分母随之变化 —— 一个删掉难例的新版本会显得「变好了」。`FULL OUTER` + `comparable=false` 让这类差异显式暴露。

| 步骤 | 动作 |
|---|---|
| 1 | 校验两个 Run 的 `dataset_version_id` 相同（否则 400） |
| 2 | `FULL OUTER JOIN` 对齐 `case_key`，两侧都为 NULL 不可能（`USING` 保证） |
| 3 | 逐条 `verdictOf()`：任一侧 `score=null` → `NOT_COMPARABLE`（**不是 0 分**） |
| 4 | 算子级：`operator_scores` 展开，按 `evaluator_key` 逐算子求均值；**分母 = 该算子有效计分数** |
| 5 | 聚合 `DiffSummary`（总数/可比/退化/提升/不变/不可比） |
| 6 | `regressionThreshold` 回显，前端必须显示「本次按阈值 X 判定」 |
| 7 | 若基线非「已确认」→ `baselineConfirmed=false` + `banner`（`BL-2`） |

**性能与索引**：两条查询各走 `ix_eval_case_results_run_score`（`(eval_run_id, score)`）。
算子级 Δ 需要 `operator_scores`，该列在 `TOAST` 里；**只对当前页的 Case 展开 jsonb**，
不要对全量展开后再分页（否则 1 万条 Case 会把 TOAST 全读一遍）。

> **红队自报的致命短板**：`operator_scores` 是 `jsonb` 数组，没有独立索引。
> 「按某算子排序/筛选」的需求一旦出现，就必须把算子分拆成 `eval_case_operator_scores` 表，
> 那是**破坏性 schema 变更**。首版刻意接受这个限制（P0 只按 Case 总分排序）。

---

## 3.7 `src/` 分层结构（与 `src/contracts/` 的边界）

```
src/
├─ contracts/              ← 纯类型 + Zod，零运行时依赖（除 zod）
│   └─ 任何层都可以 import；本层禁止 import 任何其他层
├─ db/
│   ├─ schema/             ← Drizzle schema（镜像 database-schema.md §2）
│   ├─ migrations/         ← 手写 SQL（0001…0017，含触发器与队列函数）
│   └─ repo/               ← 每表一个仓储；SQL 只在这里出现，不散落到路由
├─ lib/
│   ├─ operators/          ← 6 个算子实现（实现 EvaluatorOperator 接口）
│   ├─ gateway/            ← LiteLLM 客户端 + 重试 + token 归一化
│   ├─ cost/               ← 单价表查价与成本计算（唯一出口）
│   ├─ queue/              ← claim_next_run + 僵尸任务回收
│   └─ sse/                ← LISTEN → fan-out → 帧编码（EvalProgressFrame）
├─ worker/                 ← 常驻进程入口；只做编排，不含业务规则
├─ app/                    ← Next.js App Router：页面 + Route Handlers（薄壳，只做校验与转调）
└─ tests/
```

**依赖方向（单向，违反即架构腐化）**：`app` / `worker` → `lib` → `db` → `contracts`。
`app` **不得**直接调 `db/repo` 之外的 SQL；`lib/operators` **不得** import `db`（算子必须是纯函数）。
这条边界的唯一强制手段是 ESLint `import/no-restricted-paths`（Step 10 落地，现在先写在文档里）。

---

## 4. 安全与凭据

| 项 | 规则 |
|---|---|
| API Key 存储 | 密文入 `model_providers.api_key_ciphertext`；任何 API 响应只返回 `api_key_masked` |
| T2 鉴权 Header | 密文入 `target_versions.auth_header_ciphertext`，**不得出现在任何响应体** |
| GitHub PAT | **平台永不持有**。门禁只输出 JSON，由 CI 侧写 PR 评论（`docs/工程规则.md` §9–§10） |
| 推送渠道 | 仅飞书 / 企微 Webhook URL |
| 数据库 | 不走 MCP，迁移与测试走终端命令 / ORM |
| 密钥落盘 | 全部走 `.env*`，由 `src/.gitignore` 拦截 |

---

## 5. 待核验清单（Context7 恢复后、写代码前一次跑完）

> 本轮 Context7 MCP 未挂载（需重启会话加载），`WebFetch` / `npm view` 亦被安全分类器拦截。
> **以下框架 API 细节未经在线核验**，属实现期第一件事，不阻塞当前设计决策。

| 对象 | 要核验什么 | 失败后果 |
|---|---|---|
| `litellm` | proxy `config.yaml` schema、`/v1/chat/completions` 兼容性、并发限流参数名 | 网关一起就挂 |
| `drizzle-orm` / `drizzle-kit` | PG 列类型导入路径、`index()` / `uniqueIndex()` 写法、部分唯一索引表达、生成列支持 | 迁移编译失败 |
| `@tanstack/react-table` | v8 最新小版本、`getSortedRowModel` / `getFilteredRowModel` 确切导出名 | 前端编不过 |
| `next` | App Router 下 Route Handler 返回 `ReadableStream` 做 SSE 的写法、`runtime='nodejs'` | SSE 不通 |
| `pg` | `LISTEN/NOTIFY` 在 `node-postgres` 的连接池注意事项（需独立连接） | 通知丢失 |
| `ajv` | 2020-12 草案支持、`strict` 模式默认值 | JSON Schema 算子行为不符预期 |
| `echarts` | 按需引入路径（`echarts/core` + `RadarChart`）、SSR 下 `echarts-for-react` 是否需要 `dynamic(..., {ssr:false})` | 图表不渲染 / 首屏白屏 |
| `lucide-react` | 图标名跨版本改名清单（`AlertTriangle`→`TriangleAlert` 之类） | 构建期报未导出 |
| `zod` | 当前主版本；`z.string().uuid()` 是否已迁移到 `z.uuid()` | 契约编译失败 |

> **本轮新增三项**（echarts / lucide-react / zod 复核）来自「决策点 5」的 UI 栈与契约落地。

---

## 6. 目录与运行时形态（规划，Step 10 落地）

> 分层与依赖方向见 §3.7。本节只给「有哪些目录」，不给规则。

```
src/
├── .gitignore
├── package.json
├── contracts/            ← 契约（本步已建，唯一事实源）
├── db/
│   ├── schema/           ← Drizzle schema（镜像 database-schema.md）
│   ├── migrations/       ← 手写 SQL 0001…0017（含触发器与队列函数）
│   ├── repo/             ← 仓储层；SQL 只在这里出现
│   └── seed/
├── app/                  ← Next.js App Router（PG-01…PG-10，薄壳）
├── worker/               ← 常驻进程入口（只做编排）
├── lib/
│   ├── operators/        ← 6 个评测算子（实现 EvaluatorOperator，TDD 黄金用例）
│   ├── gateway/          ← LiteLLM 客户端 + 重试 + token 归一化
│   ├── cost/             ← 单价查价与成本计算（唯一出口）
│   ├── charts/           ← ECharts 主题（Token → option，禁止裸 #hex）
│   ├── queue/            ← claim_next_run + 僵尸任务回收
│   └── sse/              ← LISTEN → fan-out → 帧编码
└── tests/
```

---

## 7. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-11-07 | 建立本文件 | TS-1…TS-5 定稿；OPEN-1…OPEN-5 定稿；部署约束与 SSE 韧性条款确认 |
| 2026-11-07 | 契约落地 | `src/contracts/` 已生成（`common` / `dataset` / `target` / `evaluator` / `run` / `gate` / `provider` / `sse` / `api` + `openapi.yaml`）。新增 `provider.ts`：PG-09 模型网关属 P0，原先漏项。**尚未 typecheck**，见其 `README.md` 编译状态声明。 |
| 2026-11-07 | **阶段 02 二次深化** | 新增 §0.5 部署前提（国内网络 / 内网离线 / 禁 Google 在线服务）；TS-5 补图表（ECharts）与图标（Lucide）定稿及各自短板；新增 §3.5 链路一、§3.6 链路二、§3.7 `src/` 分层与依赖方向；§3.4 补 `Last-Event-ID` 分歧的显式登记（契约预留 `id`，策略仍 `snapshot_only`）；§5 补 echarts / lucide-react / zod 三项待核验。新增契约 `db-schema.ts`、`eval-contracts.ts`（含 `EvalProgressEvent` / `RunComparisonDiffResponse` / `EvaluatorOperator`）。**仍未 typecheck**（`npm install` 被安全分类器拦截）。 |
| 2026-11-07 | **SSE 回放拍板 · 分歧关闭** | 需求方拍板：**采纳 `snapshot_only`（不回放），不加环形缓冲**。§3.4 的「已承认的分歧，待拍板」改为「已拍板：不做回放」；`PROGRESS_RESUME_POLICY.pendingDecision` 换为 `decisionRecord`（记录拍板结论）。架构图业务表数 14 → **15**（新增 `case_human_labels`）；迁移编号 0016 → **0017**。 |
