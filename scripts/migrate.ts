#!/usr/bin/env tsx
/**
 * CLI：应用全部迁移。
 * 用法：npm run db:migrate
 */
import { migrate } from '../db/migrate.js';

const applied = await migrate();
if (applied.length === 0) {
  console.log('[migrate] 无待应用迁移（数据库已是最新）');
} else {
  console.log(`[migrate] 应用了 ${applied.length} 个迁移：`);
  for (const f of applied) console.log(`  ✓ ${f}`);
}
