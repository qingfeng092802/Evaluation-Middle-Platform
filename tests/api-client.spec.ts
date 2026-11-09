/**
 * 浏览器侧 API 客户端的单测。
 *
 * 这里测的是**读入侧的契约闭环**：服务端已经 `parse()` 过出站体，
 * 前端再 `parse()` 一遍，才能在字段漂移时立刻报错而不是渲染 `undefined`。
 * 断言点全部围绕「错误怎么被翻译成用户能懂的东西」，
 * 因为那正是 `BLOCKED_*` 文案能否正确显示的前提。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiClientError, apiGet, apiPatch, apiPost, toApiError } from '../lib/ui/client.js';

const Item = z.object({ id: z.string(), score: z.number() });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

const fake = (res: Response | Error): typeof fetch =>
  (() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res))) as typeof fetch;

describe('apiGet · 成功路径', () => {
  it('契约通过时返回解析后的值', async () => {
    const out = await apiGet(Item, '/api/x', { fetchImpl: fake(jsonResponse({ id: 'a', score: 0.5 })) });
    expect(out).toEqual({ id: 'a', score: 0.5 });
  });

  it('请求路径拼上 baseUrl（SSR 时需要绝对地址）', async () => {
    let seen = '';
    const impl = ((url: string) => {
      seen = url;
      return Promise.resolve(jsonResponse({ id: 'a', score: 1 }));
    }) as unknown as typeof fetch;
    await apiGet(Item, '/api/x', { fetchImpl: impl, baseUrl: 'http://127.0.0.1:3000' });
    expect(seen).toBe('http://127.0.0.1:3000/api/x');
  });
});

describe('apiGet · 失败路径必须带业务 code', () => {
  it('409 + BLOCKED_* 信封 ⇒ ApiClientError 带原 code 与 requestId', async () => {
    const res = jsonResponse(
      {
        error: {
          code: 'BLOCKED_NO_PROVIDER_CREDENTIALS',
          message: '尚未配置模型网关凭证，无法发起评测。',
          requestId: 'req-1',
        },
      },
      409,
    );
    await expect(apiGet(Item, '/api/x', { fetchImpl: fake(res) })).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'BLOCKED_NO_PROVIDER_CREDENTIALS',
      status: 409,
      requestId: 'req-1',
    });
  });

  it('404 NOT_FOUND 原样透出（页面据此渲染「评测运行不存在」）', async () => {
    const res = jsonResponse(
      { error: { code: 'NOT_FOUND', message: '评测运行不存在', requestId: 'r' } },
      404,
    );
    await expect(apiGet(Item, '/api/x', { fetchImpl: fake(res) })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('非 JSON 的错误响应（网关 502 HTML）⇒ INTERNAL_ERROR，且消息不含 HTML', async () => {
    const res = textResponse('<html>Bad Gateway</html>', 502);
    let caught: unknown = null;
    try {
      await apiGet(Item, '/api/x', { fetchImpl: fake(res) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiClientError);
    const err = caught as ApiClientError;
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.status).toBe(502);
    expect(err.message).not.toContain('<html>');
  });

  it('网络层直接抛错 ⇒ GATEWAY_UNAVAILABLE（不是 INTERNAL_ERROR）', async () => {
    await expect(
      apiGet(Item, '/api/x', { fetchImpl: fake(new Error('ECONNREFUSED')) }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  });
});

describe('apiGet · 响应形状漂移必须立刻炸', () => {
  it('缺字段 ⇒ INTERNAL_ERROR，并在消息里点名字段', async () => {
    let caught: unknown = null;
    try {
      await apiGet(Item, '/api/x', { fetchImpl: fake(jsonResponse({ id: 'a' })) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiClientError);
    expect((caught as ApiClientError).code).toBe('INTERNAL_ERROR');
    expect((caught as ApiClientError).message).toContain('score');
  });

  it('2xx 但 body 不是 JSON ⇒ INTERNAL_ERROR', async () => {
    await expect(
      apiGet(Item, '/api/x', { fetchImpl: fake(textResponse('oops', 200)) }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('apiPost', () => {
  it('带 JSON body 且过契约', async () => {
    let seenBody = '';
    const impl = ((_url: string, init?: RequestInit) => {
      seenBody = String(init?.body ?? '');
      return Promise.resolve(jsonResponse({ id: 'b', score: 0 }, 201));
    }) as unknown as typeof fetch;

    const out = await apiPost(Item, '/api/x', { name: 'n' }, { fetchImpl: impl });
    expect(seenBody).toBe('{"name":"n"}');
    expect(out).toEqual({ id: 'b', score: 0 });
  });

  it('400 校验失败也带 code', async () => {
    const res = jsonResponse(
      { error: { code: 'VALIDATION_FAILED', message: '请求体不符合契约', requestId: 'r' } },
      400,
    );
    await expect(apiPost(Item, '/api/x', {}, { fetchImpl: fake(res) })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('apiPatch', () => {
  it('PATCH + JSON body，且过契约', async () => {
    let seenMethod = '';
    let seenBody = '';
    const impl = ((_url: string, init?: RequestInit) => {
      seenMethod = String(init?.method ?? '');
      seenBody = String(init?.body ?? '');
      return Promise.resolve(jsonResponse({ id: 'c', score: 1 }));
    }) as unknown as typeof fetch;

    const out = await apiPatch(Item, '/api/x/1', { name: 'n' }, { fetchImpl: impl });
    expect(seenMethod).toBe('PATCH');
    expect(seenBody).toBe('{"name":"n"}');
    expect(out).toEqual({ id: 'c', score: 1 });
  });

  it('PATCH 的 404 也带业务 code（编辑已删除的目标时页面要说「不存在」）', async () => {
    const res = jsonResponse(
      { error: { code: 'NOT_FOUND', message: '待测目标不存在', requestId: 'r' } },
      404,
    );
    await expect(apiPatch(Item, '/api/x', {}, { fetchImpl: fake(res) })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('PATCH 响应形状漂移同样立刻炸（不因为「只是个更新」就放松校验）', async () => {
    await expect(
      apiPatch(Item, '/api/x', {}, { fetchImpl: fake(jsonResponse({ id: 'a' })) }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('toApiError · 供 React state 使用', () => {
  it('ApiClientError 转契约形状', () => {
    const err = new ApiClientError({ code: 'CONFLICT', message: 'm', status: 409, requestId: 'r' });
    expect(toApiError(err)).toEqual({ code: 'CONFLICT', message: 'm', requestId: 'r' });
  });

  it('普通异常返回 null（不伪造 code）', () => {
    expect(toApiError(new Error('x'))).toBeNull();
  });
});
