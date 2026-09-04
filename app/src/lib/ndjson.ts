/**
 * Newline-delimited JSON, both ends.
 *
 * Evidence collection is twenty-odd upstream calls and takes half a minute. A
 * spinner over that is a lie of omission: the interesting part is *which*
 * endpoint answered, what it cost in credits, and what failed. Streaming the
 * events as they happen shows the machine working, and it also keeps a
 * multi-megabyte tier-2 bundle from ever having to reach the browser.
 */

export type StreamEvent = { type: string } & Record<string, unknown>;

export interface EventSink {
  send(event: StreamEvent): void;
  close(): void;
}

/** Wraps a producer in a streaming NDJSON `Response`. */
export function ndjsonStream(producer: (sink: EventSink) => Promise<void>): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const sink: EventSink = {
        send(event) {
          if (closed) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        },
        close() {
          if (closed) return;
          closed = true;
          controller.close();
        },
      };

      void producer(sink)
        .catch((cause: unknown) => {
          sink.send({
            type: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => {
          sink.close();
        });
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // Streaming through a proxy that buffers would defeat the point.
      'x-accel-buffering': 'no',
    },
  });
}

/** Reads an NDJSON response, calling back once per complete line. */
export async function readNdjson(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('the server returned no body');

  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') onEvent(JSON.parse(line) as StreamEvent);
      newline = buffer.indexOf('\n');
    }
  }

  const tail = buffer.trim();
  if (tail !== '') onEvent(JSON.parse(tail) as StreamEvent);
}
