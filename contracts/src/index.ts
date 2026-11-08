/**
 * 契约统一出口。
 *
 * 使用方一律 `import { … } from '@eval-platform/contracts'`，
 * 不直接深引 `src/*.ts`——这样将来拆分/合并文件不构成破坏性变更。
 *
 * ⚠️ **本目录尚未通过 typecheck。** 详见 README.md「编译状态声明」。
 * 在 Step 10 通过 `npm run typecheck` 之前，业务代码不得依赖本目录的导出。
 */

// 共享原语、错误契约、状态机基础
export * from './common.js';

// ED-01…ED-03 · 评测集与样本
export * from './dataset.js';

// ED-05 · 待测目标（T1 / T2 判别联合）
export * from './target.js';

// ED-04 · 算子（模板侧 + 实例侧 + 单算子评分）
export * from './evaluator.js';

// ED-06 / ED-07 · 运行与逐条结果
export * from './run.js';

// ED-08 · 基线与门禁
export * from './gate.js';

// 厂商凭证与单价（PG-09 / PG-10；成本唯一事实源）
export * from './provider.js';

// SSE 事件契约
export * from './sse.js';

// REST 请求 / 响应体（按页面组织）
export * from './api.js';

// 数据库事实的可编译索引（表名 / 迁移顺序 / 触发器名单；不含 DDL）
export * from './db-schema.js';

// 对外契约命名层：EvalProgressEvent / RunComparisonDiffResponse / 算子实现接口
export * from './eval-contracts.js';
