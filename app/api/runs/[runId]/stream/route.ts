/**
 * `GET /api/runs/{runId}/stream`（Batch 3 · 交付物 2）。
 *
 * 这一层只做**翻译**：把 `runEventStream()` 的 `StreamFrame` 写成 SSE 字节。
 * 业务口径（何时发 case、计数从哪读）全部在 `lib/api/services/run-stream.ts`。
 *
 * ## 三条必须做对的传输细节
 *
 * 1. **每帧以空行结尾**（`\n\n`）。少了它浏览器会把它和下一帧粘成一个事件，
 *    表现为「页面不动、控制台不报错」——`EventSource` 不会抱怨半条事件。
 * 2. **`Last-Event-ID` 原样透传，不据此回放。** `PROGRESS_RESUME_POLICY.mode`
 *    是 `snapshot_only`：重连的第一步是拉快照（客户端做），服务端首帧仍是 snapshot。
 *    若在这里按 id 补发历史，配合客户端累加就成了双倍计数。
 * 3. **run 不存在时回 404 JSON，而不是一条 200 的事件流。**
 *    `EventSource` 遇到 200 断流会自动重连；对不存在的 run，服务端每次都要
 *    新建一条 `LISTEN` 连接 —— 错一个 URL 就能把连接数打满。
 *
 * 客户端断开时 `ReadableStream.cancel()` 会调用 `generator.return()`，
 * 生成器自己的 `finally` 随即关掉那条 `LISTEN` 连接。
 */
import type { NextRequest } from 'next/server';
import { EvalProgressFrame } from '@eval-platform/contracts';
import { NotFoundError, toErrorResponse } from '@/lib/api/http';
import { runEventStream, type StreamFrame } from '@/lib/api/services/run-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 一帧 SSE 的线上字节。`data` 必须是单行 JSON（多行 `data:` 不在契约内）。 */
function formatFrame(frame: StreamFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** 出站契约校验：形状不对在这里炸，而不是让浏览器静默丢弃。 */
function checkFrame(frame: StreamFrame): StreamFrame {
  const parsed = EvalProgressFrame.parse(frame);
  return { id: parsed.id, event: parsed.event, data: parsed.data } as StreamFrame;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await ctx.params;
  const lastEventId = req.headers.get('last-event-id') ?? undefined;

  const generator = runEventStream({ runId, lastEventId });

  // 先取首帧再决定是否升级成事件流：run 不存在时生成器首帧是 `error/NOT_FOUND`，
  // 这时还没写任何 SSE 字节，可以干净地回一个普通 JSON 错误。
  const first = await generator.next();
  if (first.done) {
    return new Response(null, { status: 204 });
  }
  if (first.value.event === 'error' && first.value.data.type === 'error') {
    await generator.return(undefined);
    if (first.value.data.code === 'NOT_FOUND') {
      return toErrorResponse(new NotFoundError('评测运行不存在'));
    }
  }
  const firstFrame = checkFrame(first.value);

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(formatFrame(firstFrame)));
        for await (const frame of generator) {
          controller.enqueue(encoder.encode(formatFrame(checkFrame(frame))));
        }
        controller.close();
      } catch (err) {
        // 生成器内部异常（DB 抖动等）：关掉流让客户端按 §3.5 [6] 重连拉快照，
        // 而不是把一条坏连接留在这里继续心跳。
        controller.error(err);
      }
    },
    cancel() {
      void generator.return(undefined);
    },
  });

  // 浏览器关标签页 / 切走时 Next 会 abort 请求；显式 return 让 `LISTEN` 立刻释放，
  // 不依赖 GC 或心跳唤醒后的下一次循环。
  req.signal.addEventListener('abort', () => {
    void generator.return(undefined);
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // 事件流不能被任何一层缓存（CDN / 代理 / 浏览器）攒起来
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 反代（nginx）默认会缓冲响应体，关了它进度才会真的「实时」
      'x-accel-buffering': 'no',
    },
  });
}
