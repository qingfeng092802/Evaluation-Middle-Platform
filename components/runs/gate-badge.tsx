import * as React from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * 准出门禁徽章 —— `PG-01` 列表的「准出门禁」列。
 *
 * ## 为什么它恒为「未评估」
 *
 * 门禁裁决读 `gate_evaluations`，而该表在 M1 是空表（`SPEC-M1` §1.1）：
 * 裁决依赖「已确认基线」与三级阈值，二者随 M4 `US-017` 才落地。
 * `SPEC-M1` §6.5 `T-2` 对此有三条明令：**不填假值、不派生猜测值、不隐藏列**。
 *
 * 所以本组件**不接受任何 props**。这不是懒，是防线：
 * 只要签名里能传 `status` / `score`，早晚有人写出
 * 「`status === 'COMPLETED'` ⇒ 准出」——那会让一个从未被门禁检查过的运行
 * 在界面上看起来「已通过准出」。用户据此发布，后果比多显示一列空白严重得多。
 *
 * 等到 M4 接真裁决时，本组件换成读 `gate_evaluations` 的版本，
 * 语义色（`pass` / `fail`）也**只在那一刻**才允许出现。
 *
 * ## 为什么用 `muted` 而不是 `outline`
 *
 * 「未评估」是一个**事实陈述**，不是待办提醒。`muted` 让它退到信息层级的后位，
 * 不与「状态」列的彩色徽章抢注意力（`DESIGN.md` §4.4 语义色只用于真实状态）。
 */
export function GateBadge(): React.ReactElement {
  return <Badge variant="muted">未评估</Badge>;
}
