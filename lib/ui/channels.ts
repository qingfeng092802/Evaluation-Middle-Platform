/**
 * PG-09「推送渠道」Tab 的展示派生（M4 Batch 4，`US-018`）。
 *
 * Token 明文**只显示一次**（签发响应即唯一可见机会）：本文件给的是那一次
 * 展示的状态机——「已签发待复制」→「已关闭（只能重置）」。
 */
import type { GateChannel, RegressionGate } from '@eval-platform/contracts';

export const CHANNEL_KINDS: readonly { readonly value: GateChannel['kind']; readonly label: string }[] = [
  { value: 'feishu', label: '飞书' },
  { value: 'wecom', label: '企业微信' },
  { value: 'webhook', label: '通用 Webhook' },
];

export function channelKindLabel(kind: GateChannel['kind']): string {
  return CHANNEL_KINDS.find((c) => c.value === kind)?.label ?? kind;
}

/** 规则的渠道摘要：「飞书×1 + 通用×2」；无渠道 ⇒ 空串。 */
export function channelsSummaryOf(gate: RegressionGate): string {
  if (gate.channels.length === 0) return '';
  const counts = new Map<GateChannel['kind'], number>();
  for (const c of gate.channels) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${channelKindLabel(k)}×${n}`).join(' + ');
}

/** 追加一条渠道（去重：同 kind+url 不重复入列——重复推送只会造成重复告警）。 */
export function withChannel(
  channels: readonly GateChannel[],
  next: GateChannel,
): GateChannel[] {
  if (channels.some((c) => c.kind === next.kind && c.url === next.url)) return [...channels];
  return [...channels, next];
}

/** 移除一条渠道（按 kind+url 定位）。 */
export function withoutChannel(
  channels: readonly GateChannel[],
  target: GateChannel,
): GateChannel[] {
  return channels.filter((c) => !(c.kind === target.kind && c.url === target.url));
}

/**
 * 回调 Token 的一次性展示状态。
 *
 * `revealedToken === null` 时面板不渲染；一旦用户关闭，token 清空——
 * 明文只存在于「本次签发响应」与「当前这次展示」里，不进任何 state 持久层。
 */
export interface TokenOnceState {
  readonly revealedToken: string | null;
  readonly gateId: string | null;
}

export function openTokenOnce(_prev: TokenOnceState, gateId: string, token: string): TokenOnceState {
  return { revealedToken: token, gateId };
}

export function closeTokenOnce(_prev: TokenOnceState): TokenOnceState {
  return { revealedToken: null, gateId: null };
}
