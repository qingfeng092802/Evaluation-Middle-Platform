/**
 * 厂商只读服务（`PG-06` T1 表单的「模型」下拉）。
 *
 * 之所以还在 `lib/api/services/` 里再包一层而不是路由直接调仓储：
 * 分层规则是 `app → lib → db`，路由不直接 import `db`。
 * 这层目前没有业务逻辑，但它是**唯一**的越线点——将来要加「只列启用中的厂商」
 * 或权限过滤，改动落在这里而不是散进各路由。
 */
import type { ModelProvider } from '@eval-platform/contracts';
import { listProviderViews } from '../../../db/repo/modelProviders.js';

/** 全部厂商（可回传视图，绝不含 `apiKeyCiphertext`）。 */
export async function listProviders(): Promise<ModelProvider[]> {
  return listProviderViews();
}
