import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { DenyAllAuthorizer } from '../src/authorization.js';
import {
  FixtureBackend,
  ProviderError,
  type ConversationBackfillPage,
  type MautrixMetaBackend
} from '../src/backend.js';
import type { ConversationThreadMessages } from '../src/domain.js';
import { TOOL_DEFINITIONS, registerMarketplaceTools, type MarketplaceToolOptions } from '../src/tools.js';
import { MautrixMetaClient } from '../src/mautrix-meta.js';
import { MautrixMetaApiBackend } from '../src/mautrix-meta-backend.js';

const META_TOOL_NAMES = ['messenger_meta_threads_list', 'messenger_meta_thread_read', 'messenger_meta_thread_backfill'] as const;

interface RecordedMetaCall {
  readonly method: 'listThreads' | 'readThread' | 'backfillThread';
  readonly input: Record<string, unknown>;
  readonly signal: unknown;
}

// A synthetic `mautrix-meta` boundary recording every call, including the signal it received.
function fakeMautrixMetaBackend(): { backend: MautrixMetaBackend; calls: RecordedMetaCall[] } {
  const calls: RecordedMetaCall[] = [];
  const tailMessages = [
    { sender: 'other' as const, sender_name: 'synthetic seller', text: 'Is the synthetic lamp still available?', sent_at: '2025-10-01T10:00:00.000Z' },
    { sender: 'you' as const, text: 'Yes, it is still available.', sent_at: '2025-10-01T10:05:00.000Z' }
  ];
  const backend: MautrixMetaBackend = {
    name: 'fake-mautrix-meta',
    async listThreads(input, signal) {
      calls.push({ method: 'listThreads', input: { ...input }, signal });
      return {
        threads: [
          { thread_id: 'synth-meta-t1', participants: ['synthetic seller'], preview: 'Is the synthetic lamp still available?' },
          { thread_id: 'synth-meta-t2', preview: 'Second synthetic thread' }
        ],
        truncated: true
      };
    },
    async readThread(input, signal) {
      calls.push({ method: 'readThread', input: { ...input }, signal });
      if (input.thread_id !== 'synth-meta-t1') return null;
      const page: ConversationThreadMessages = {
        thread_id: input.thread_id,
        messages: tailMessages,
        coverage: { window: 'tail', scanned_rows: tailMessages.length, truncated: false }
      };
      return page;
    },
    async backfillThread(input, signal) {
      calls.push({ method: 'backfillThread', input: { ...input }, signal });
      if (input.thread_id !== 'synth-meta-t1') return null;
      const messages = [
        { sender: 'other' as const, text: 'Older synthetic message', sent_at: '2025-09-30T09:00:00.000Z' },
        { sender: 'you' as const, text: 'Older synthetic reply', sent_at: '2025-09-30T09:30:00.000Z' }
      ];
      const page: ConversationBackfillPage = {
        messages,
        coverage: {
          window: 'backfill',
          before: input.before,
          scanned_rows: messages.length,
          has_more_before: false,
          truncated: false
        }
      };
      return page;
    }
  };
  return { backend, calls };
}

function metaOptions(backend?: MautrixMetaBackend, extra: MarketplaceToolOptions = {}): MarketplaceToolOptions {
  return { authorizer: new DenyAllAuthorizer(), ...(backend ? { metaConversations: backend } : {}), ...extra };
}

async function withSession<T>(options: MarketplaceToolOptions, action: (client: Client) => Promise<T>): Promise<T> {
  const server = new Server({ name: 'messenger-meta-tools-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'messenger-meta-tools-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerMarketplaceTools(server, new FixtureBackend(), { error: () => undefined }, options);
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await action(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function listToolNames(options: MarketplaceToolOptions): Promise<string[]> {
  return withSession(options, async (client) => (await client.listTools()).tools.map(({ name }) => name));
}

async function callTool(options: MarketplaceToolOptions, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await withSession(options, (client) => client.callTool({ name, arguments: args }));
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {});
}

describe('messenger_meta tool registration', () => {
  it('omits all three messenger_meta tools when no meta backend is wired', async () => {
    const names = await listToolNames(metaOptions());
    for (const name of META_TOOL_NAMES) expect(names).not.toContain(name);
  });

  it('registers all three messenger_meta tools once the fake meta backend is wired', async () => {
    const names = await listToolNames(metaOptions(fakeMautrixMetaBackend().backend));
    for (const name of META_TOOL_NAMES) expect(names).toContain(name);
  });

  it('keeps messenger_send and messenger_prepare gated on ConversationBackend methods, not on meta wiring', async () => {
    const names = await listToolNames(metaOptions(fakeMautrixMetaBackend().backend));
    expect(names).not.toContain('messenger_send');
    expect(names).not.toContain('messenger_prepare');
  });
});

describe('messenger_meta tool dispatch over the fake backend', () => {
  it('lists synthetic threads with the meta backend name, truncated passthrough, and the default limit', async () => {
    const { backend, calls } = fakeMautrixMetaBackend();
    const output = await callTool(metaOptions(backend), 'messenger_meta_threads_list', {});
    expect(output.ok).toBe(true);
    expect(output.backend).toBe('fake-mautrix-meta');
    expect(output.truncated).toBe(true);
    expect(output.threads).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('listThreads');
    expect(calls[0]?.input).toEqual({ limit: 10 });
  });

  it('reads the synthetic thread tail with its coverage passed through', async () => {
    const { backend } = fakeMautrixMetaBackend();
    const output = await callTool(metaOptions(backend), 'messenger_meta_thread_read', { thread_id: 'synth-meta-t1' });
    expect(output).toMatchObject({ ok: true, backend: 'fake-mautrix-meta', thread_id: 'synth-meta-t1' });
    expect(output.coverage).toEqual({ window: 'tail', scanned_rows: 2, truncated: false });
    const messages = output.messages as Array<{ sent_at?: string }>;
    expect(messages).toHaveLength(2);
    expect(messages.every(({ sent_at }) => sent_at !== undefined)).toBe(true);
  });

  it('reports NOT_FOUND when the meta backend has no such thread', async () => {
    const { backend } = fakeMautrixMetaBackend();
    const output = await callTool(metaOptions(backend), 'messenger_meta_thread_read', { thread_id: 'synth-meta-unknown' });
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns a backfill page with the full coverage object echoed for the requested bound', async () => {
    const { backend, calls } = fakeMautrixMetaBackend();
    const before = '2025-10-01T10:00:00.000Z';
    const output = await callTool(metaOptions(backend), 'messenger_meta_thread_backfill', { thread_id: 'synth-meta-t1', before, limit: 2 });
    expect(output).toMatchObject({ ok: true, backend: 'fake-mautrix-meta', thread_id: 'synth-meta-t1' });
    expect(output.coverage).toEqual({ window: 'backfill', before, scanned_rows: 2, has_more_before: false, truncated: false });
    expect(output.messages).toHaveLength(2);
    expect(calls[0]?.input).toEqual({ thread_id: 'synth-meta-t1', before, limit: 2 });
  });

  it('reports NOT_FOUND when backfilling a thread the meta backend does not have', async () => {
    const { backend } = fakeMautrixMetaBackend();
    const output = await callTool(metaOptions(backend), 'messenger_meta_thread_backfill', { thread_id: 'synth-meta-unknown', before: '2025-10-01T10:00:00.000Z' });
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('rejects malformed backfill arguments as InvalidParams before touching the backend', async () => {
    const { backend, calls } = fakeMautrixMetaBackend();
    const before = '2025-10-01T10:00:00.000Z';
    const invalidCases: Array<Record<string, unknown>> = [
      { thread_id: 'synth-meta-t1', before: '2025-13-45', limit: 10 },
      { thread_id: 'synth-meta-t1' },
      { thread_id: 'synth-meta-t1', before, limit: 51 },
      { thread_id: 'synth-meta-t1', before, limit: 0 },
      { thread_id: 'synth-meta-t1', before, limit: 10, surprise: true },
      // The bound crosses the wire as Unix milliseconds, so a bound with a finer fraction
      // would be rounded by the wire and would no longer be the bound the window is cut at.
      { thread_id: 'synth-meta-t1', before: '2025-10-01T10:00:00.0005Z', limit: 10 }
    ];
    for (const args of invalidCases) {
      let rejected: unknown;
      try {
        rejected = await callTool(metaOptions(backend), 'messenger_meta_thread_backfill', args);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(McpError);
      expect((rejected as McpError).code).toBe(ErrorCode.InvalidParams);
    }
    expect(calls).toHaveLength(0);
  });

  it('passes an AbortSignal to the backend on every meta tool call', async () => {
    const { backend, calls } = fakeMautrixMetaBackend();
    const options = metaOptions(backend);
    await callTool(options, 'messenger_meta_threads_list', {});
    await callTool(options, 'messenger_meta_thread_read', { thread_id: 'synth-meta-t1' });
    await callTool(options, 'messenger_meta_thread_backfill', { thread_id: 'synth-meta-t1', before: '2025-10-01T10:00:00.000Z' });
    expect(calls).toHaveLength(3);
    expect(calls.map(({ method }) => method)).toEqual(['listThreads', 'readThread', 'backfillThread']);
    for (const call of calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect((call.signal as AbortSignal).aborted).toBe(false);
    }
  });

  it('surfaces a meta ProviderError as a structured failure with its action hint', async () => {
    const backend: MautrixMetaBackend = {
      name: 'throwing-mautrix-meta',
      async listThreads() {
        throw new ProviderError('CAPTCHA_REQUIRED', 'A synthetic Meta challenge is present.', { action_required: 'manual_resolution_in_official_app' });
      },
      async readThread() {
        return null;
      },
      async backfillThread() {
        return null;
      }
    };
    const output = await callTool(metaOptions(backend), 'messenger_meta_threads_list', {});
    expect(output.ok).toBe(false);
    expect(output.error).toMatchObject({
      code: 'CAPTCHA_REQUIRED',
      message: 'A synthetic Meta challenge is present.',
      action_required: 'manual_resolution_in_official_app'
    });
  });
});

describe('messenger_meta tool output over the real transport backend', () => {
  const baseUrl = 'http://127.0.0.1:9000';
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const backendWith = (fetchImpl: typeof fetch) => new MautrixMetaApiBackend({ client: new MautrixMetaClient({ baseUrl, fetchImpl }) });

  it('returns a bounded listing with honest truncation when the transport pages wider than the caller asked for', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ thread_id: `synth-meta-t${index}`, preview: `Synthetic preview ${index}.` }));
    const backend = backendWith(async () => ok({ threads: many, truncated: false }));
    const output = await callTool(metaOptions(backend), 'messenger_meta_threads_list', { limit: 10 });
    // The transport's page is wider than the caller's window; the window the caller receives
    // stays inside the public bound and says that more threads exist beyond it.
    expect(output.ok).toBe(true);
    expect((output.threads as unknown[]).length).toBe(10);
    expect(output.truncated).toBe(true);
  });

  it('returns a bounded tail with honest truncation when the transport pages wider than the public bound', async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      sender: 'other',
      text: `Synthetic tail row ${index}.`,
      sent_at: new Date(Date.parse('2025-03-01T10:00:00.000Z') + index * 60_000).toISOString()
    }));
    const backend = backendWith(async () => ok({ messages: many, coverage: { window: 'tail', scanned_rows: many.length, truncated: false } }));
    const output = await callTool(metaOptions(backend), 'messenger_meta_thread_read', { thread_id: 'synth-meta-t1' });
    expect(output.ok).toBe(true);
    expect((output.messages as unknown[]).length).toBe(50);
    expect(output.coverage).toMatchObject({ window: 'tail', truncated: true });
  });

  it('reports a typed failure, not an internal error, when the transport breaks the coverage contract', async () => {
    const backend = backendWith(async () => ok({ messages: [{ sender: 'other', text: 'Synthetic undated row.' }], coverage: { window: 'tail', scanned_rows: 1, truncated: false } }));
    const output = await callTool(metaOptions(backend), 'messenger_meta_thread_read', { thread_id: 'synth-meta-t1' });
    expect(output.ok).toBe(false);
    expect(output.error).toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'The mautrix-meta transport returned a window that does not satisfy the pinned coverage contract.'
    });
  });
});

describe('TOOL_DEFINITIONS for the messenger_meta surface', () => {
  it('declares each meta tool read-only on the (facebook, default, messenger_meta) scope', () => {
    for (const name of META_TOOL_NAMES) {
      expect(TOOL_DEFINITIONS[name]).toEqual({
        riskClass: 'read',
        scope: { provider: 'facebook', account: 'default', surface: 'messenger_meta' }
      });
    }
  });

  it('declares no send, prepare, or high-consequence risk on any meta-scope tool', () => {
    const metaScoped = Object.entries(TOOL_DEFINITIONS).filter(([, definition]) => definition.scope.surface === 'messenger_meta');
    expect(metaScoped.length).toBeGreaterThan(0);
    for (const [, definition] of metaScoped) {
      expect(definition.riskClass).toBe('read');
    }
  });
});

describe('marketplace_status meta reporting', () => {
  it('reports the mautrix-meta transport and backend when the meta boundary is wired', async () => {
    const { backend } = fakeMautrixMetaBackend();
    const output = await callTool(metaOptions(backend, { messengerTransport: 'mautrix-meta' }), 'marketplace_status', {});
    expect(output.ok).toBe(true);
    expect(output.messenger_transport).toBe('mautrix-meta');
    expect(output.capabilities).toContainEqual({ surface: 'messenger_meta', provider: 'facebook', backend: 'fake-mautrix-meta' });
  });

  it('reports a null meta backend and no transport when nothing meta is wired', async () => {
    const output = await callTool(metaOptions(), 'marketplace_status', {});
    expect(output.ok).toBe(true);
    expect(output.messenger_transport).toBeUndefined();
    expect(output.capabilities).toContainEqual({ surface: 'messenger_meta', provider: 'facebook', backend: null });
  });

  it('never returns the service credential in the status output', async () => {
    // The credential authenticates Musebridge to its own transport service. It stays in the
    // client and never crosses into a tool output.
    const client = new MautrixMetaClient({ baseUrl: 'https://transport.internal.example', serviceToken: 'synth-service-token' });
    const backend = new MautrixMetaApiBackend({ client });
    const output = await callTool(metaOptions(backend, { messengerTransport: 'mautrix-meta' }), 'marketplace_status', {});
    expect(output.ok).toBe(true);
    expect(JSON.stringify(output)).not.toContain('synth-service-token');
  });
});
