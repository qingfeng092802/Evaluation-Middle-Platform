/**
 * Route Handler 公共设施。
 *
 * 三件事只在这里做一次：
 *  1. **统一错误信封**（`{ error: ApiError }`）——业务代码只管抛语义化异常，
 *     不需要在每个 handler 里手写 status/code 映射；
 *  2. **入参解析**（查询串 → 契约 schema），失败一律 400 `VALIDATION_FAILED`；
 *  3. **出站契约校验**——所有响应体在返回前过一遍 `契约.parse()`。
 *     这条是「前后端不漂移」的物理保障：形状不对会在这里炸，而不是在浏览器里渲染出 `NaN`。
 *
 * 本文件不写 SQL、不含业务口径，只做搬运。
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import type { z } from 'zod';
import type { ErrorCode } from '@eval-platform/contracts';
import { BlockedError, NotFoundError } from '../runner/create-run.js';
import { isCheckViolation, isRaiseException, isUniqueViolation } from '../../db/repo/_client.js';

/** 语义化异常在此统一再导出，服务层只需 import 一处。 */
export { BlockedError, NotFoundError };

/** 资源冲突（内容指纹重复、期望指纹不符等）。405/409 的语义差异见各调用点。 */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** 入参不合法（比 ZodError 更直白的业务前置失败，如「文件为空」）。 */
export class BadRequestError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BadRequestError';
  }
}

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

function envelope(
  code: ErrorCode,
  message: string,
  id: string,
  details?: Record<string, unknown>,
): ErrorBody {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      requestId: id,
    },
  };
}

/** 把任意异常映射成 HTTP 响应。**这是唯一一处** status ↔ code 的映射表。 */
export function toErrorResponse(err: unknown): NextResponse<ErrorBody> {
  const id = randomUUID();

  if (err instanceof ZodError) {
    return NextResponse.json(
      envelope('VALIDATION_FAILED', '请求体不符合契约', id, {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
      { status: 400 },
    );
  }

  if (err instanceof BadRequestError) {
    return NextResponse.json(
      envelope('VALIDATION_FAILED', err.message, id, err.details),
      { status: 400 },
    );
  }

  if (err instanceof NotFoundError) {
    return NextResponse.json(envelope('NOT_FOUND', err.message, id), { status: 404 });
  }

  if (err instanceof BlockedError) {
    // 三条阻塞校验：码本身就是契约枚举的一部分，前端据此渲染对应文案
    return NextResponse.json(envelope(err.code as ErrorCode, err.message, id), { status: 409 });
  }

  if (err instanceof ConflictError) {
    return NextResponse.json(
      envelope('CONFLICT', err.message, id, err.details),
      { status: 409 },
    );
  }

  if (isUniqueViolation(err)) {
    return NextResponse.json(envelope('CONFLICT', '违反唯一约束', id), { status: 409 });
  }

  if (isRaiseException(err)) {
    // 触发器主动 RAISE：不可变表写入、非法状态流转
    return NextResponse.json(
      envelope('IMMUTABLE_VIOLATION', (err as Error).message, id),
      { status: 409 },
    );
  }

  if (isCheckViolation(err)) {
    return NextResponse.json(
      envelope('VALIDATION_FAILED', (err as Error).message, id),
      { status: 400 },
    );
  }

  console.error('[api] 未处理异常：', err);
  return NextResponse.json(envelope('INTERNAL_ERROR', '服务端内部错误', id), { status: 500 });
}

/**
 * 包裹一个 handler，统一捕获异常。
 *
 * 刻意不做 `try/catch` 之外的任何事：不要在包装器里塞业务逻辑，
 * 否则「出错时到底返回什么」会变得难以推理。
 */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * 出站契约校验 + JSON 序列化。
 *
 * 任何越过这一层的响应体都会先被 `schema.parse()` 拒绝，所以前端拿到的形状
 * 必然是契约里声明过的那一种。
 */
export function ok<T extends z.ZodTypeAny>(
  schema: T,
  body: z.input<T>,
  status = 200,
): NextResponse {
  const parsed = schema.parse(body) as unknown;
  return NextResponse.json(parsed, { status });
}

/** 解析查询串（`URLSearchParams` → 普通对象 → 契约 schema）。 */
export function parseQuery<S extends z.ZodTypeAny>(schema: S, url: URL): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) raw[k] = v;
  return schema.parse(raw) as z.output<S>;
}

/** 读请求体 JSON；空 body 视为 `{}`（让契约给出精确的缺字段报错）。 */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError('请求体不是合法 JSON');
  }
}
