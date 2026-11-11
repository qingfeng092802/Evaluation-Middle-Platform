#!/usr/bin/env tsx
/**
 * CLI：清空全部业务数据（保留结构）。
 * 用法：npm run db:reset
 *
 * 仅供本地开发与验收使用。生产环境没有对应入口 —— 历史实体一律不可删（PT-2）。
 */
import { resetDatabase } from '../db/migrate.js';

await resetDatabase();
console.log('[reset] 全部业务表已清空（结构保留）');
