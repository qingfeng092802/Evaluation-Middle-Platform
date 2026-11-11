/**
 * 导入器 · 规范化与指纹的**再导出**。
 *
 * 实现在 `db/canonical.ts`：`content_hash` / `seq` 是落库不变量，
 * 且分层规则要求 `db` 只能依赖 `contracts`（`technical-solution.md` §3.7），
 * 所以真正的位置必须在下层，`lib` 向上引用。
 *
 * 保留这个文件是为了让 `lib/import/*` 的调用点（JSONL / CSV 解析、服务层）
 * 不必知道"指纹算在哪一层"这件事——它们只需要 `canonical.js` 这一个入口。
 */
export {
  canonicalJson,
  computeContentHash,
  deriveCaseKey,
  normalizeCases,
} from '../../db/canonical.js';
export type { NormalizedCase } from '../../db/canonical.js';
