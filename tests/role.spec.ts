/**
 * MVP 角色模拟单元测试（裁定 1，正文见 SPEC-M3 §2 Batch 1「实现前提」）。
 *
 * 覆盖两件事：
 *  1. `lib/ui/role.ts` 状态机：默认 A、切换、订阅通知、退订；
 *  2. `lib/ui/client.ts` 的请求头注入：所有请求带 `x-role`，切到 B 后
 *     decision 的 403 语义才有前端前提（PG-09 确认按钮依赖它）。
 * localStorage 持久化属浏览器行为，Node 里不测（代码有 typeof window 守卫）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getRole, setRole, subscribeRole } from '../lib/ui/role.js';
import { apiGet, apiPost } from '../lib/ui/client.js';

const OK = z.object({ ok: z.boolean() });

beforeEach(() => {
  setRole('A'); // Node 里无 localStorage，仅重置内存态
});

describe('role 状态机', () => {
  it('默认 A', () => {
    expect(getRole()).toBe('A');
  });

  it('setRole 切 B：内存态更新并通知订阅者', () => {
    const seen: Array<'A' | 'B'> = [];
    const off = subscribeRole(() => seen.push(getRole()));
    setRole('B');
    expect(getRole()).toBe('B');
    expect(seen).toEqual(['B']);
    off();
    setRole('A');
  });

  it('退订后不再通知', () => {
    let n = 0;
    const off = subscribeRole(() => {
      n += 1;
    });
    off();
    setRole('B');
    expect(n).toBe(0);
    setRole('A');
  });
});

describe('client 注入 X-Role', () => {
  function fakeCapture(headers: { current: unknown }): typeof fetch {
    return ((_url: string | URL, init: RequestInit) => {
      headers.current = init.headers;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
  }

  it('默认请求带 x-role: A', async () => {
    const captured = { current: undefined as unknown };
    await apiGet(OK, '/api/x', { fetchImpl: fakeCapture(captured) });
    expect((captured.current as Record<string, string>)['x-role']).toBe('A');
  });

  it('切到 B 后请求带 x-role: B（PG-09 确认按钮的前端前提）', async () => {
    setRole('B');
    const captured = { current: undefined as unknown };
    await apiGet(OK, '/api/x', { fetchImpl: fakeCapture(captured) });
    expect((captured.current as Record<string, string>)['x-role']).toBe('B');
    setRole('A');
  });

  it('POST 同样携带（decision 是 POST）', async () => {
    setRole('B');
    const captured = { current: undefined as unknown };
    await apiPost(OK, '/api/x', { foo: 1 }, { fetchImpl: fakeCapture(captured) });
    expect((captured.current as Record<string, string>)['x-role']).toBe('B');
    setRole('A');
  });
});
