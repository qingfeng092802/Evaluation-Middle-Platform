/**
 * 数据库表注册表 —— `docs/facts/database-schema.md` 的**可编译索引**。
 *
 * 本文件**不重复定义列、类型、约束**。列的事实源永远只有
 * `docs/facts/database-schema.md` §2 的 DDL；这里只固化那些
 * 「必须被代码与测试同时引用、且改了会静默出错」的元信息：
 *
 *  - 15 张表的**名字与迁移顺序**（少一张 = 外键建不出来）；
 *  - **哪些表整表不可变**、`eval_runs` 何时冻结；
 *  - **17 个触发器的确切名字**（`T-10` 断言用）。
 *
 * 为什么触发器名要进代码：`technical-solution.md` TS-4 短板 3 已点名
 * 「Drizzle 表达不了触发器，schema 与真实 DDL 存在漂移风险」。
 * `T-10` 是这条风险的唯一护栏 —— 若测试里硬编码字符串，改名时会两头不同步；
 * 若用本文件的常量，至少改名只能改一处，且类型会逼着所有引用一起改。
 *
 * ⚠️ 未编译验证，详见 README.md。
 */

/** 表名（与 SQL 中的表名逐字一致，全小写蛇形）。 */
export const TABLE_NAMES = [
  'datasets',
  'dataset_versions',
  'dataset_cases',
  'model_providers',
  'model_prices',
  'targets',
  'target_versions',
  'evaluators',
  'eval_runs',
  'run_evaluators',
  'eval_case_results',
  'baselines',
  'regression_gates',
  'gate_evaluations',
  'case_human_labels',
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/**
 * 迁移顺序。
 *
 * **必须严格按此顺序执行**（`database-schema.md` §1）：后面的表通过外键
 * 引用前面的表，乱序会直接 `relation does not exist`。
 */
export const MIGRATION_ORDER: ReadonlyArray<{
  readonly no: number;
  readonly table: TableName;
  readonly file: string;
}> = [
  { no: 1, table: 'datasets', file: '0001_datasets.sql' },
  { no: 2, table: 'dataset_versions', file: '0002_dataset_versions.sql' },
  { no: 3, table: 'dataset_cases', file: '0003_dataset_cases.sql' },
  { no: 4, table: 'model_providers', file: '0004_model_providers.sql' },
  { no: 5, table: 'model_prices', file: '0005_model_prices.sql' },
  { no: 6, table: 'targets', file: '0006_targets.sql' },
  { no: 7, table: 'target_versions', file: '0007_target_versions.sql' },
  { no: 8, table: 'evaluators', file: '0008_evaluators.sql' },
  { no: 9, table: 'eval_runs', file: '0009_eval_runs.sql' },
  { no: 10, table: 'run_evaluators', file: '0010_run_evaluators.sql' },
  { no: 11, table: 'eval_case_results', file: '0011_eval_case_results.sql' },
  { no: 12, table: 'baselines', file: '0012_baselines.sql' },
  { no: 13, table: 'regression_gates', file: '0013_regression_gates.sql' },
  { no: 14, table: 'gate_evaluations', file: '0014_gate_evaluations.sql' },
  { no: 15, table: 'case_human_labels', file: '0015_case_human_labels.sql' },
] as const;

/**
 * 非建表迁移（在建表之后执行，顺序固定）。
 *
 * 单独列出而不是塞进 `MIGRATION_ORDER`：`MIGRATION_ORDER` 的每一项都对应**一张表**，
 * 这两项是跨表的横切逻辑，混进去会让「表数 = 迁移数」这条不变量失效。
 */
export const CROSS_CUTTING_MIGRATIONS = [
  { no: 16, file: '0016_immutability_triggers.sql', purpose: 'immutable table triggers' },
  { no: 17, file: '0017_queue_functions.sql', purpose: 'claim_next_run / reclaim_stale_runs' },
] as const;

/**
 * 整表完全不可变的表（`0015_immutability_triggers.sql` §3.2 的循环列表）。
 *
 * 这些表上**任何** `UPDATE` / `DELETE` 都会被 `reject_mutation()` 拒绝。
 * 想要"改"，唯一路径是新建一行（新版本 / 新运行）。
 */
export const FULLY_IMMUTABLE_TABLES = [
  'dataset_versions',
  'dataset_cases',
  'target_versions',
  'run_evaluators',
  'eval_case_results',
  'gate_evaluations',
  'case_human_labels',
] as const satisfies ReadonlyArray<TableName>;

/**
 * 进入终态后整行冻结的表（`eval_runs`）。
 *
 * 与 `FULLY_IMMUTABLE_TABLES` 的区别：`eval_runs` 在 `PENDING` / `RUNNING`
 * 期间**必须可写**（进度、计数、汇总），只有落到 `COMPLETED` /
 * `PARTIAL_FAILED` / `FAILED` / `CANCELLED` 之后才冻结。
 * 规则载体是 `eval_runs_guard()`，不是 `reject_mutation()`。
 */
export const TERMINAL_FROZEN_TABLES = ['eval_runs'] as const satisfies ReadonlyArray<TableName>;

/** 状态机受触发器约束（只能单向流转、不得重复裁定）的表。 */
export const STATE_MACHINE_GUARDED_TABLES = [
  'eval_runs',
  'baselines',
] as const satisfies ReadonlyArray<TableName>;

/**
 * 触发器全名单（`T-10` 存在性断言的标准答案）。
 *
 * 构成：7 张完全不可变表 × (`no_update` + `no_delete`) = 14
 *      + `eval_runs` 的 `guard` + `no_delete`          =  2
 *      + `baselines` 的 `guard`（状态机无删除触发器）    =  1
 *                                                     ------
 *                                                        17
 *
 * ⚠️ 历史记录：本名单原为 15（6 张不可变表）。2026-11-07 需求方拍板新增
 * 第 15 张表 `case_human_labels` 后变为 17。`database-schema.md` §6 的 `T-10`
 * 已同步为 17，两处必须一致。
 */
export const TRIGGER_NAMES = [
  'trg_dataset_versions_no_update',
  'trg_dataset_versions_no_delete',
  'trg_dataset_cases_no_update',
  'trg_dataset_cases_no_delete',
  'trg_target_versions_no_update',
  'trg_target_versions_no_delete',
  'trg_run_evaluators_no_update',
  'trg_run_evaluators_no_delete',
  'trg_eval_case_results_no_update',
  'trg_eval_case_results_no_delete',
  'trg_gate_evaluations_no_update',
  'trg_gate_evaluations_no_delete',
  'trg_case_human_labels_no_update',
  'trg_case_human_labels_no_delete',
  'trg_eval_runs_guard',
  'trg_eval_runs_no_delete',
  'trg_baselines_guard',
] as const;
export type TriggerName = (typeof TRIGGER_NAMES)[number];

/** 触发器数量。迁移测试直接断言 `pg_trigger` 中命中本名单的条数等于它。 */
export const EXPECTED_TRIGGER_COUNT = TRIGGER_NAMES.length;

/** 队列表达式的唯一属主：`claim_next_run()`（`0017_queue_functions.sql`）。 */
export const QUEUE_FUNCTION_NAME = 'claim_next_run';

/** 单元队列通过 `NOTIFY` 使用的通道名。应用层监听这个频道再 fan-out 给 SSE。 */
export const RUN_PROGRESS_CHANNEL = 'run_progress';

/**
 * 僵尸任务回收函数名（`0017_queue_functions.sql` §4.1）。
 *
 * `claim_next_run()` 只领 `PENDING`，因此 worker 崩溃留下的 `RUNNING` 行
 * **必须**由本函数召回，否则任务永远卡住。二者是一对，不能只实现其一。
 */
export const RECLAIM_FUNCTION_NAME = 'reclaim_stale_runs';

/** 迁移文件中必须存在的辅助函数全名单。 */
export const DB_FUNCTION_NAMES = [QUEUE_FUNCTION_NAME, RECLAIM_FUNCTION_NAME] as const;

/**
 * 列、约束、索引的事实源地址。
 *
 * 出现「代码里的表和文档里的表对不上」时，**以该文档为准**，
 * 并回头修本文件 —— 不要反向改文档来迁就代码。
 */
export const DB_SCHEMA_FACT_SOURCE = 'docs/facts/database-schema.md';
