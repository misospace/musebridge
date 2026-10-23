import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { canonicalActionInput, HmacGrantAuthorizer, subjectDigest, type ActionRequest } from '../src/authorization.js';
import { InMemoryGrantConsumptionStore } from '../src/grant-state.js';
import { FixtureBackend, renderDeliveredMessage, type ConversationBackend } from '../src/backend.js';
import { FIXTURE_CONVERSATIONS } from '../src/fixtures.js';
import { prepareOutputSchema, type ThreadSendInput } from '../src/domain.js';
import { registerMarketplaceTools, TOOL_DEFINITIONS, type MarketplaceToolOptions } from '../src/tools.js';

const SECRET = '0123456789abcdef0123456789abcdef01234567';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const DISCLOSURE = 'The rendered draft appends the idempotency token in brackets; the counterparty will see that marker when the message is sent.';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CallToolHandler = (
  request: { id?: unknown; params: { name: string; arguments?: Record<string, unknown> } },
  extra: { signal: AbortSignal }
) => Promise<unknown>;

type CapturedHandlers = {
  call?: CallToolHandler;
  list?: (...args: unknown[]) => unknown;
};

function captureHandlers(): { server: McpServer; handlers: CapturedHandlers } {
  const handlers: CapturedHandlers = {};
  const server = {
    registerCapabilities: () => undefined,
    setRequestHandler: (schema: unknown, handler: (...args: unknown[]) => unknown) => {
      if (schema === CallToolRequestSchema) handlers.call = handler as unknown as CallToolHandler;
      else if (schema === ListToolsRequestSchema) handlers.list = handler;
    }
  };
  return { server: server as unknown as McpServer, handlers };
}

function register(options: MarketplaceToolOptions = {}): CapturedHandlers {
  const { server, handlers } = captureHandlers();
  registerMarketplaceTools(server, new FixtureBackend(), { error: vi.fn() }, options);
  return handlers;
}

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: { ok: boolean } & Record<string, unknown>;
  isError?: boolean;
};

async function invoke(handlers: CapturedHandlers, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  expect(handlers.call).toBeDefined();
  const signal = new AbortController().signal;
  const result = await handlers.call!({ id: 1, params: { name, arguments: args } }, { signal });
  return result as unknown as ToolCallResult;
}

function prepareInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { thread_id: 't-synth-0002', message: 'I can meet you Saturday morning for pickup.', ...overrides };
}

async function prepare(handlers: CapturedHandlers, overrides: Record<string, unknown> = {}): Promise<ToolCallResult> {
  return invoke(handlers, 'messenger_prepare', prepareInput(overrides));
}

function preparedSendInput(result: ToolCallResult): ThreadSendInput {
  return result.structuredContent.send_input as ThreadSendInput;
}

type GrantFields = {
  grant_id: string;
  provider: string;
  account: string;
  surface: string;
  action: string;
  subject_digest: string;
  expires_at: string;
};

function signEnvelope(grant: GrantFields): { grant: GrantFields; signature: string } {
  return { grant, signature: createHmac('sha256', SECRET).update(canonicalActionInput(grant), 'utf8').digest('hex') };
}

function buildGrant(input: ThreadSendInput, overrides: Partial<GrantFields> = {}): { grant: GrantFields; signature: string } {
  return signEnvelope({
    grant_id: 'grant-0123456789abcdef0123456789',
    provider: 'facebook',
    account: 'default',
    surface: 'messenger',
    action: 'messenger_send',
    subject_digest: subjectDigest(input),
    expires_at: EXPIRES_AT,
    ...overrides
  });
}

function grantAuthorizer(): HmacGrantAuthorizer {
  return new HmacGrantAuthorizer({ secret: SECRET, store: new InMemoryGrantConsumptionStore() });
}

function prepareSurface(conversations: ConversationBackend = new FixtureBackend()): CapturedHandlers {
  return register({ conversations, authorizer: grantAuthorizer(), approvalGrant: vi.fn() });
}

async function withClient(
  options: MarketplaceToolOptions,
  exercise: (client: Client) => Promise<void>
): Promise<Array<{ name: string }>> {
  const server = new Server({ name: 'messenger-prepare-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'messenger-prepare-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerMarketplaceTools(server, new FixtureBackend(), { error: vi.fn() }, options);
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    await exercise(client);
    return listed.tools;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function listToolNames(options: MarketplaceToolOptions): Promise<string[]> {
  return (await withClient(options, async () => undefined)).map(({ name }) => name);
}

describe('messenger_prepare draft output', () => {
  it('publishes the digest of the validated send payload and never reports the draft as sent', async () => {
    const handlers = prepareSurface();

    const result = await prepare(handlers);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      backend: 'fixture',
      thread_id: 't-synth-0002',
      status: 'draft',
      sent: false,
      participant: 'Synthetic Buyer',
      draft_message: 'I can meet you Saturday morning for pickup.'
    });
    // The digest is over the published send payload, which is the object a later messenger_send
    // builds its ActionRequest from — not over the smaller prepare input.
    expect(result.structuredContent.subject_digest).toBe(subjectDigest(result.structuredContent.send_input));
    expect(result.structuredContent.subject_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.structuredContent.send_input).toMatchObject({ thread_id: 't-synth-0002', idempotency_token: result.structuredContent.idempotency_token });
  });

  it('grants no approval: it never consults the host approval seam, even with an authorizer installed', async () => {
    const approvalGrant = vi.fn();
    const handlers = register({ conversations: new FixtureBackend(), authorizer: grantAuthorizer(), approvalGrant });

    const result = await prepare(handlers);

    expect(result.isError).toBe(false);
    expect(result.structuredContent.status).toBe('draft');
    expect(approvalGrant).not.toHaveBeenCalled();
  });

  it('mints a fresh v4 idempotency token per call and a digest that follows it', async () => {
    const handlers = prepareSurface();

    const first = await prepare(handlers);
    const second = await prepare(handlers);

    const firstToken = first.structuredContent.idempotency_token as string;
    const secondToken = second.structuredContent.idempotency_token as string;
    expect(firstToken).toMatch(UUID_V4);
    expect(secondToken).toMatch(UUID_V4);
    expect(firstToken).not.toBe(secondToken);
    expect(first.structuredContent.subject_digest).not.toBe(second.structuredContent.subject_digest);
  });

  it('renders the delivered form with the counterparty marker disclosed exactly once', async () => {
    const handlers = prepareSurface();

    const result = await prepare(handlers);
    const sendInput = preparedSendInput(result);
    const rendered = result.structuredContent.rendered_message as string;

    expect(rendered).toBe(renderDeliveredMessage(sendInput));
    expect(rendered.split(sendInput.idempotency_token)).toHaveLength(2);
    expect(rendered.match(new RegExp(sendInput.idempotency_token, 'g'))).toHaveLength(1);
    expect(result.structuredContent.counterparty_marker).toEqual({
      included: true,
      token: sendInput.idempotency_token,
      occurrences: 1,
      disclosure: DISCLOSURE
    });
    expect(DISCLOSURE.length).toBeLessThanOrEqual(320);
  });

  it('refuses a draft whose counterparty marker is not exactly once', async () => {
    // The token is minted after the message is validated, so the rendered count is structurally 1;
    // pin the schema guard anyway so a future change to the render form cannot slip a double marker
    // past a host that relies on it to reconcile a send.
    const draft = (await prepare(prepareSurface())).structuredContent;

    expect(prepareOutputSchema.safeParse({ ...draft, counterparty_marker: { ...(draft.counterparty_marker as Record<string, unknown>), occurrences: 2 } }).success).toBe(false);
    expect(prepareOutputSchema.safeParse(draft).success).toBe(true);
  });
});

describe('messenger_prepare payload parity with messenger_send', () => {
  it('authorizes a send granted over the prepared payload and confirms it as sent', async () => {
    const conversations = new FixtureBackend();
    const prepared = await prepare(prepareSurface(conversations));
    const sendInput = preparedSendInput(prepared);

    const approvalGrant = vi.fn((request: ActionRequest) => buildGrant(sendInput));
    const handlers = register({ conversations, authorizer: grantAuthorizer(), approvalGrant });

    const sent = await invoke(handlers, 'messenger_send', { ...sendInput });

    expect(sent.isError).toBe(false);
    expect(sent.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: sendInput.thread_id, status: 'sent' });
    // The ActionRequest messenger_send authorized is digested from the very payload prepare published.
    expect(approvalGrant.mock.calls[0]?.[0]).toMatchObject({
      provider: 'facebook',
      account: 'default',
      surface: 'messenger',
      action: 'messenger_send',
      subjectDigest: prepared.structuredContent.subject_digest
    });
    const thread = conversations.readThread({ thread_id: sendInput.thread_id }, new AbortController().signal);
    expect(thread?.messages.some(({ sender, text }) => sender === 'you' && text.includes(`[${sendInput.idempotency_token}]`))).toBe(true);
  });

  it('changes the published digest when the text, the thread, or the token changes', async () => {
    const handlers = prepareSurface();

    const baseline = await prepare(handlers);
    const otherText = await prepare(handlers, { message: 'I can meet you Sunday afternoon instead.' });
    const otherThread = await prepare(handlers, { thread_id: 't-synth-0001' });

    const digests = [baseline, otherText, otherThread].map(({ structuredContent }) => structuredContent.subject_digest);
    expect(new Set(digests).size).toBe(3);
    // Each published digest still belongs to its own published payload, never to another call's.
    for (const result of [baseline, otherText, otherThread]) {
      expect(result.structuredContent.subject_digest).toBe(subjectDigest(result.structuredContent.send_input));
    }
  });
});

describe('FixtureBackend.prepareDraft', () => {
  it('returns the last counterparty message sender for each synthetic thread', () => {
    const conversations = new FixtureBackend();
    const signal = new AbortController().signal;

    expect(conversations.prepareDraft({ thread_id: 't-synth-0001', message: 'Still available.', idempotency_token: 'tok-abc123def456ghij' }, signal))
      .toEqual({ participant: 'Synthetic Seller' });
    expect(conversations.prepareDraft({ thread_id: 't-synth-0002', message: 'How about 40?', idempotency_token: 'tok-abc123def456ghij' }, signal))
      .toEqual({ participant: 'Synthetic Buyer' });
  });

  it('reports NOT_FOUND for an unknown thread instead of drafting into nothing', async () => {
    const conversations = new FixtureBackend();

    expect(conversations.prepareDraft({ thread_id: 't-synth-missing', message: 'Is it still there?', idempotency_token: 'tok-abc123def456ghij' }, new AbortController().signal))
      .toBeNull();

    const result = await prepare(prepareSurface(), { thread_id: 't-synth-missing' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.ok).toBe(false);
    // An absent thread is an absent resource, exactly as messenger_thread_read reports it, and no
    // digest is published for a send that could never be authorized.
    expect(result.structuredContent).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'No conversation thread matched the supplied identifier.' }
    });
    expect(result.structuredContent.send_input).toBeUndefined();
    expect(result.structuredContent.subject_digest).toBeUndefined();
  });

  it('never mutates the fixtures and never records a send', () => {
    const conversations = new FixtureBackend();
    const signal = new AbortController().signal;
    const before = JSON.stringify(FIXTURE_CONVERSATIONS);
    const beforeThread = conversations.readThread({ thread_id: 't-synth-0001' }, signal);

    conversations.prepareDraft({ thread_id: 't-synth-0001', message: 'Yes, still available.', idempotency_token: 'tok-abc123def456ghij' }, signal);

    expect(JSON.stringify(FIXTURE_CONVERSATIONS)).toBe(before);
    const afterThread = conversations.readThread({ thread_id: 't-synth-0001' }, signal);
    expect(afterThread).toEqual(beforeThread);
    expect(afterThread?.messages).toHaveLength(3);
    expect(afterThread?.messages.some(({ text }) => text.includes('tok-abc123def456ghij'))).toBe(false);
  });
});

describe('messenger_prepare registration', () => {
  it('declares the prepare risk class and the messenger scope', () => {
    expect(TOOL_DEFINITIONS.messenger_prepare.riskClass).toBe('prepare');
    expect(TOOL_DEFINITIONS.messenger_prepare.scope).toEqual({ provider: 'facebook', account: 'default', surface: 'messenger' });
  });

  it('lists messenger_prepare only when the conversation surface is configured', async () => {
    const withSurface = await listToolNames({ conversations: new FixtureBackend(), authorizer: grantAuthorizer() });
    expect(withSurface).toContain('messenger_prepare');

    const withoutSurface = await listToolNames({ authorizer: grantAuthorizer() });
    expect(withoutSurface).not.toContain('messenger_prepare');
    expect(withoutSurface).not.toContain('messenger_send');
    // The read-only messenger tools stay listed; only the conversation-gated draft is hidden.
    expect(withoutSurface).toContain('messenger_thread_read');
  });

  it('survives a real client round trip that validates the published output schema', async () => {
    await withClient({ conversations: new FixtureBackend(), authorizer: grantAuthorizer() }, async (client) => {
      // The client validates structuredContent against the declared outputSchema, so a successful
      // round trip proves the published prepare contract accepts the draft the tool returns.
      const prepared = await client.callTool({ name: 'messenger_prepare', arguments: prepareInput() });
      expect(prepared.isError).toBeFalsy();
      expect(prepared.structuredContent).toMatchObject({ ok: true, status: 'draft', sent: false, participant: 'Synthetic Buyer' });
      expect((prepared.structuredContent as Record<string, unknown>).subject_digest)
        .toBe(subjectDigest((prepared.structuredContent as Record<string, unknown>).send_input));
    });
  });

  it('rejects a messenger_prepare call as an unknown tool when the surface is not configured', async () => {
    const handlers = register({ authorizer: grantAuthorizer() });

    await expect(prepare(handlers)).rejects.toMatchObject({
      name: 'McpError',
      code: ErrorCode.InvalidParams,
      message: `MCP error ${ErrorCode.InvalidParams}: Unknown tool: messenger_prepare`
    });
  });

  it('rejects malformed arguments as JSON-RPC InvalidParams', async () => {
    const handlers = prepareSurface();

    await expect(prepare(handlers, { message: '' })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(prepare(handlers, { message: 'ok', extra: true })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(prepare(handlers, { thread_id: 'bad/id', message: 'ok' })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(invoke(handlers, 'messenger_prepare', { thread_id: 't-synth-0002' })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(prepare(handlers, { thread_id: 't-synth-0002', message: `x${String.fromCharCode(9)}bad` })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
