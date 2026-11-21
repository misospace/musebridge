import { describe, expect, it } from 'vitest';
import { drainErrorBody } from '../src/error-body.js';

describe('drainErrorBody', () => {
  it('reads the body to completion so the keep-alive connection is released and reused', async () => {
    const response = new Response('synthetic upstream failure', { status: 503 });
    await drainErrorBody(response);
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
