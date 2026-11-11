# 契约（Contracts）

> **本目录是「可编译的接口 / 数据契约」的唯一事实源。**
> 规则依据：`docs/工程规则.md` §1「单一事实源原则」、§3「契约与 SPEC 先行」。
>
> 表结构与数据库约束见 [`docs/facts/database-schema.md`](../../docs/facts/database-schema.md)；
> 评分与成本口径见 [`docs/facts/technical-solution.md`](../../docs/facts/technical-solution.md)。

---

## 文件结构

```
src/contracts/
├── package.json          依赖与脚本
├── tsconfig.json         strict 类型配置
├── openapi.yaml          REST 接口骨架（人可读）
└── src/
    ├── common.ts         共享原语（UUID / 分数 / 金额 / 分页 / 错误码 / 状态机）
    ├── dataset.ts        Dataset / DatasetVersion / DatasetCase（ED-01…ED-03）
    ├── target.ts         Target / TargetVersion（ED-05，T1/T2 判别联合）
    ├── evaluator.ts      Evaluator / RunEvaluator / OperatorScore（ED-04）
    ├── run.ts            EvalRun / EvalCaseResult / 状态机（ED-06 / ED-07）
    ├── gate.ts           Baseline / RegressionGate（ED-08）
    ├── provider.ts       ModelProvider / ModelPrice / 成本台账（PG-09 / PG-10）
    ├── sse.ts            SSE 事件契约
    ├── api.ts            REST 请求 / 响应体（按页面组织）
    ├── db-schema.ts      数据库事实的可编译索引（表名 / 迁移顺序 / 触发器名单）
    ├── eval-contracts.ts 对外命名层 + 算子实现接口 + 双版本 Diff 响应
    └── index.ts          统一导出
```

> `provider.ts` 是相对原规划的**新增项**：PG-09「模型网关」是 P0 页面（`US-015`），
> 若没有 `ModelProvider` / `ModelPrice` 契约，P0 闭环就缺一块，
> 且「成本只由自有单价表计算」这条红线的物理载体也无处声明。

> `db-schema.ts` **不含任何 DDL**。它只固化「表名、迁移顺序、触发器全名单」这类
> 必须被代码与测试同时引用、且改错会静默失败的元信息。列与约束的事实源始终是
> `docs/facts/database-schema.md` §2 —— 双写 DDL 必然漂移。
>
> `eval-contracts.ts` 承担三件事：把需求文档里的命名（`EvalProgressEvent` /
> `RunComparisonDiffResponse`）钉到既有契约上、给出 `EvaluatorOperator` 算子实现接口、
> 给出 SSE 线上帧 `EvalProgressFrame`。**它不新增领域事实**，别名一律指向既有 schema。

---

## 契约与文档的对应关系

| 契约文件 | 事实文档章节 | 支撑页面 |
|---|---|---|
| `common.ts` | `database-schema.md` §0；`pages-and-flows.md` §4 状态机 | 全局 |
| `dataset.ts` | `database-schema.md` §2.1–2.3；`product-overview.md` §7 | PG-05 |
| `target.ts` | `database-schema.md` §2.6–2.7；`product-overview.md` §4 | PG-06 |
| `evaluator.ts` | `database-schema.md` §2.8 / §2.10 | PG-02 步骤 3、PG-07 |
| `run.ts` | `database-schema.md` §2.9 / §2.11；`pages-and-flows.md` §4 | PG-01 / PG-02 / PG-03 |
| `gate.ts` | `database-schema.md` §2.12–2.14；`product-overview.md` §5 | PG-08 / PG-09 |
| `provider.ts` | `database-schema.md` §2.4–2.5；`technical-solution.md` TS-2 | PG-09 / PG-10 |
| `sse.ts` | `technical-solution.md` §3.4 | PG-03 区域 3 |
| `api.ts` | `pages-and-flows.md` 全部页面 | PG-01…PG-10 |
| `db-schema.ts` | `database-schema.md` §1 / §3 / §4 | 迁移测试、`T-10` |
| `eval-contracts.ts` | `technical-solution.md` §3；`database-schema.md` §2.11 | PG-03 / PG-04 / PG-08 |

---

## 设计上刻意为之的四处「不提供」

| 不提供的契约 | 原因 |
|---|---|
| `DatasetVersionUpdate` / `DatasetCaseUpdate` | `PT-2` 不可变。没有 Update 契约比文档里写一句「不可变」更难违反。 |
| 任何含 `apiKey` / `authHeader` 的**读取**形状 | 凭据只写不读。`WRITE_ONLY_FIELDS`（`api.ts`）集中登记了这处非对称，供安全审查对照。 |
| ApiRun 的「重跑并覆盖」入口 | 重跑 = 新建 EvalRun（`OPEN-4` 无缓存、`PT-2` 不可变）。 |
| SSE 事件回放接口 | `OPEN-4` / `TS-3` 定稿「不回放」。`EvalProgressFrame.id` 只是预留位；`PROGRESS_RESUME_POLICY.mode` 固定为 `snapshot_only`，重连一律先拉全量快照。**2026-11-07 需求方已拍板采纳此策略，不加环形缓冲，分歧关闭。** |

---

## 使用方式

```bash
cd src/contracts
npm install
npm run typecheck    # tsc --noEmit
```
