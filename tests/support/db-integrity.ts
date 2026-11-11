/**
 * 数据库级「声明计数 = 实际行数」校验。
 *
 * 三张表各自有一列是**声明值**，真实数据在另一张表：
 *
 * | 声明                          | 实际                                              |
 * | ----------------------------- | ------------------------------------------------- |
 * | `dataset_versions.case_count` | `count(*) FROM dataset_cases`                     |
 * | `targets.current_version_no`  | `max(version_no) FROM target_versions`            |
 * | `eval_runs.total_cases`       | 所属 `dataset_versions.case_count`                |
 *
 * 生产代码（`db/repo/datasets.ts` 的 `createVersion`、`db/repo/targets.ts`
 * 的 `createTarget`/`updateTarget`）在事务里同时写两边，因此线上不会漂移。
 * 会漂移的只有测试夹具：直接手写 SQL 时很容易只写声明值。
 *
 * `B-07`/`B-08` 的现场就是如此：dev 库里 10 个数据集全部是
 * `case_count=1` 而实际 0 行，10 个 Target 全部是 `current_version_no=0`
 * 却挂着 v1 —— 页面上「样本数 1」，点进去空白。
 *
 * 这里的断言不针对某一条用例，而是把不变量写成可复用的**体检函数**：
 * 任何真库 spec 都可以在收尾时调用它，让「夹具留下的残渣」当场变成红灯，
 * 而不是等下一次人工点页面才发现。
 */
import { getPool } from '../../db/schema/index.js';

export interface IntegrityViolation {
  /** 出问题的表（便于定位）。 */
  readonly table: string;
  /** 行标识（名称或 id），便于把违例对回具体夹具。 */
  readonly subject: string;
  /** 人话描述：声明什么、实际是什么。不用 `declared`/`actual` 两个数字，
   *  因为 `base_url` 那条不是计数，硬套成数字只会读反。 */
  readonly detail: string;
}

async function rows<T extends Record<string, unknown>>(
  text: string,
): Promise<T[]> {
  const res = await getPool().query<T>(text);
  return res.rows;
}

/** `dataset_versions.case_count` 必须等于该版本的 `dataset_cases` 行数。 */
export async function datasetCaseCountViolations(): Promise<IntegrityViolation[]> {
  const list = await rows<{ name: string; version_no: number; case_count: number; actual: string }>(`
    SELECT d.name,
           dv.version_no,
           dv.case_count,
           (SELECT count(*)::text FROM dataset_cases c WHERE c.dataset_version_id = dv.id) AS actual
      FROM dataset_versions dv
      JOIN datasets d ON d.id = dv.dataset_id
     WHERE dv.case_count <> (SELECT count(*) FROM dataset_cases c WHERE c.dataset_version_id = dv.id)
     ORDER BY d.name, dv.version_no
  `);
  return list.map((r) => ({
    table: 'dataset_versions',
    subject: `${r.name} v${String(r.version_no)}`,
    detail: `case_count 声明 ${String(r.case_count)} 条，实际 ${r.actual} 行`,
  }));
}

/** `targets.current_version_no` 必须等于 `target_versions` 里的最大版本号（无版本时为 0）。 */
export async function targetVersionPointerViolations(): Promise<IntegrityViolation[]> {
  const list = await rows<{ name: string; current_version_no: number; actual: string }>(`
    SELECT t.name,
           t.current_version_no,
           COALESCE((SELECT max(v.version_no) FROM target_versions v WHERE v.target_id = t.id), 0)::text
             AS actual
      FROM targets t
     WHERE t.current_version_no <>
           COALESCE((SELECT max(v.version_no) FROM target_versions v WHERE v.target_id = t.id), 0)
     ORDER BY t.name
  `);
  return list.map((r) => ({
    table: 'targets',
    subject: r.name,
    detail: `current_version_no 声明 v${String(r.current_version_no)}，target_versions 最大 v${String(r.actual)}`,
  }));
}

/**
 * 被 Target 引用的厂商必须带 `base_url`。
 *
 * T1 的调用地址来自厂商配置；`base_url` 为空时运行期才会报错，
 * 而那时任务已经进了队列。测试夹具写的厂商同理必须可调用。
 */
export async function providerBaseUrlViolations(): Promise<IntegrityViolation[]> {
  const list = await rows<{ name: string; null_url: boolean }>(`
    SELECT DISTINCT p.name, (p.base_url IS NULL) AS null_url
      FROM model_providers p
      JOIN target_versions tv ON tv.model_provider_id = p.id
     WHERE p.base_url IS NULL
     ORDER BY p.name
  `);
  return list.map((r) => ({
    table: 'model_providers',
    subject: r.name,
    detail: '被 Target 引用，但 base_url 为 NULL（运行期才会报错）',
  }));
}

/** `eval_runs.total_cases` 必须等于其数据集版本声明的 `case_count`。 */
export async function runTotalCasesViolations(): Promise<IntegrityViolation[]> {
  const list = await rows<{ name: string; total_cases: number; case_count: number }>(`
    SELECT r.name, r.total_cases, dv.case_count
      FROM eval_runs r
      JOIN dataset_versions dv ON dv.id = r.dataset_version_id
     WHERE r.total_cases <> dv.case_count
     ORDER BY r.name
  `);
  return list.map((r) => ({
    table: 'eval_runs',
    subject: r.name,
    detail: `total_cases 声明 ${String(r.total_cases)}，数据集版本声明 ${String(r.case_count)}`,
  }));
}

/** 一次跑完全部不变量，返回所有违例（空数组 = 数据一致）。 */
export async function allIntegrityViolations(): Promise<IntegrityViolation[]> {
  return [
    ...(await datasetCaseCountViolations()),
    ...(await targetVersionPointerViolations()),
    ...(await providerBaseUrlViolations()),
    ...(await runTotalCasesViolations()),
  ];
}

/** 把违例列表压成人能读的一行行，用于失败时的断言消息。 */
export function describeViolations(list: readonly IntegrityViolation[]): string {
  if (list.length === 0) return '（无不一致）';
  return list.map((v) => `${v.table} · ${v.subject}：${v.detail}`).join('\n');
}
