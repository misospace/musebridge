import { describe, expect, it } from 'vitest';
import { drainErrorBody } from '../src/error-body.js';

describe('drainErrorBody', () => {
  it('reads the body to completion so the keep-alive connection is released and reused', async () => {
    const response = new Response('synthetic upstream failure', { status: 503 });
    await drainErrorBody(response);
    expect(response.bodyUsed).toBe(true);
  });

  it('streams the body to a discarding sink instead of buffering it through text()', async () => {
    const chunks = 64;
    let produced = 0;
    const body = new ReadableStream<string>({
      pull(controller) {
        if (produced === chunks) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(`synthetic-chunk-${produced}`);
      }
    });
    const response = new Response(body, { status: 503 });
    let textCalls = 0;
    Object.defineProperty(response, 'text', {
      value: () => {
        textCalls += 1;
        return Promise.resolve('');
      }
    });

    await drainErrorBody(response);

    // Every chunk was pulled through the discard sink, so a large error body is never held.
    expect(produced).toBe(chunks);
    // Buffering the whole body with `text()` would reintroduce the unbounded-memory path.
    expect(textCalls).toBe(0);
    expect(response.bodyUsed).toBe(true);
  });

  it('resolves for a response with no body', async () => {
    await expect(drainErrorBody(new Response(null, { status: 503 }))).resolves.toBeUndefined();
  });

  it('resolves when the body was already consumed', async () => {
    const response = new Response('synthetic', { status: 503 });
    await response.text();
    await expect(drainErrorBody(response)).resolves.toBeUndefined();
  });

  it('resolves when the body is locked by a reader', async () => {
    const response = new Response('synthetic', { status: 503 });
    response.body?.getReader();
    await expect(drainErrorBody(response)).resolves.toBeUndefined();
  });

  it('resolves when the body stream errors instead of masking the caller typed error', async () => {
    const broken = new ReadableStream({ start(controller) { controller.error(new Error('synthetic body failure')); } });
    await expect(drainErrorBody(new Response(broken, { status: 503 }))).resolves.toBeUndefined();
  });
});
