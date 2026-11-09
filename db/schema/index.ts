/**
 * Drizzle 镜像集中出口 + 数据库连接池。
 *
 * `getDb()` 是**唯一**的 Drizzle 实例来源；连接池单例避免 Next.js 每次热重载都新建池。
 * 生产代码（`db/repo/*`）从这里取 `db`，绝不在路由里 `new Pool()`。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { databaseUrl } from '../migrate.js';
import * as datasetsSchema from './datasets.js';
import * as evaluatorsSchema from './evaluators.js';
import * as governanceSchema from './governance.js';
import * as providersSchema from './providers.js';
import * as runsSchema from './runs.js';
import * as targetsSchema from './targets.js';

export * from './datasets.js';
export * from './evaluators.js';
export * from './governance.js';
export * from './providers.js';
export * from './runs.js';
export * from './targets.js';

export const fullSchema = {
  ...datasetsSchema,
  ...providersSchema,
  ...targetsSchema,
  ...evaluatorsSchema,
  ...runsSchema,
  ...governanceSchema,
};

/** 进程级连接池单例。`globalThis` 兜住 Next.js dev 的模块重载。 */
const globalForDb = globalThis as unknown as { __evalPool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.__evalPool) {
    globalForDb.__evalPool = new Pool({
      connectionString: databaseUrl(),
      // 单机开发默认值；并发上限由 worker 的 WORKER_CONCURRENCY 控制，不靠池子堆。
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return globalForDb.__evalPool;
}

export type Db = ReturnType<typeof createDb>;

function createDb() {
  return drizzle(getPool(), { schema: fullSchema });
}

const globalForDrizzle = globalThis as unknown as { __evalDb?: Db };

export function getDb(): Db {
  if (!globalForDrizzle.__evalDb) globalForDrizzle.__evalDb = createDb();
  return globalForDrizzle.__evalDb;
}

/** 测试收尾用：关池并清空单例。 */
export async function closeDb(): Promise<void> {
  if (globalForDb.__evalPool) {
    await globalForDb.__evalPool.end();
    delete globalForDb.__evalPool;
  }
  delete globalForDrizzle.__evalDb;
}
