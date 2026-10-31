import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DenyAllAuthorizer } from '../src/authorization.js';
import { FixtureBackend, type ConversationBackend } from '../src/backend.js';
import { TOOLS, registerMarketplaceTools, type MarketplaceToolOptions, type ToolEntry } from '../src/tools.js';

/** A tool whose entry declares the capability it needs. */
type GatedTool = Extract<ToolEntry, { readonly requires: { readonly method: string } }>;

/** The tools whose own entry declares a capability requirement. */
const gatedTools = TOOLS.filter((tool): tool is GatedTool => 'requires' in tool);

async function listToolNames(options: MarketplaceToolOptions): Promise<string[]> {
  const server = new Server({ name: 'tools-registry-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'tools-registry-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerMarketplaceTools(server, new FixtureBackend(), { error: () => undefined }, options);
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.map(({ name }) => name);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** Calls one tool over an in-memory session and returns its structured result. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = new Server({ name: 'tools-registry-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'tools-registry-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerMarketplaceTools(server, new FixtureBackend(), { error: () => undefined }, { conversations: new FixtureBackend(), authorizer: new DenyAllAuthorizer() });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name, arguments: args });
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** A conversation backend that serves the reads but not the named method. */
function conversationBackendWithout(method: string): ConversationBackend {
  const backend = new FixtureBackend();
  Object.defineProperty(backend, method, { value: undefined, configurable: true });
  return backend;
}

describe('tool registry declaration', () => {
  it('declares the capability requirement of each gated tool on the tool entry itself', () => {
    // The gate reads the requirement off the entry, so the gated set is the declared set: a tool
    // that needs a backend capability cannot be registered without saying which one.
    expect(gatedTools.map(({ name }) => name).sort()).toEqual([
      'consumer_threads_list',
      'consumer_threads_search',
      'messenger_prepare',
      'messenger_send'
    ]);
    const conversations = new FixtureBackend();
    for (const tool of gatedTools) {
      expect(typeof Reflect.get(conversations, tool.requires.method)).toBe('function');
    }
  });

  it('registers a gated tool only when the wired backend provides the declared capability', async () => {
    const declaredNames = TOOLS.map(({ name }) => name).sort();
    for (const tool of gatedTools) {
      // The backend serves everything except the declared method, so exactly that one tool is
      // withheld: the gate neither over-filters the other tools nor advertises the gated one.
      const withoutCapability = await listToolNames({
        conversations: conversationBackendWithout(tool.requires.method),
        authorizer: new DenyAllAuthorizer()
      });
      expect(withoutCapability.sort()).toEqual(declaredNames.filter((name) => name !== tool.name));

      const withCapability = await listToolNames({
        conversations: new FixtureBackend(),
        authorizer: new DenyAllAuthorizer()
      });
      expect(withCapability.sort()).toEqual(declaredNames);
    }
  });
});

describe('consumer discovery tools over the fixture backend', () => {
  it('lists synthetic personal threads with fixture-complete coverage', async () => {
    const output = await callTool('consumer_threads_list', { limit: 2 });
    expect(output.ok).toBe(true);
    expect(output.truncated).toBe(true);
    const threads = output.threads as Array<{ thread_id: string; route: string }>;
    expect(threads).toHaveLength(2);
    expect(threads.every(({ route }) => route === 'plain')).toBe(true);
    expect(output.coverage).toEqual({ threads_observed: 3, window: 'recent-load', complete: true });
  });

  it('searches synthetic threads in memory with field provenance', async () => {
    const output = await callTool('consumer_threads_search', { query: 'BIKE' });
    expect(output.ok).toBe(true);
    const matches = output.matches as Array<{ thread_id: string; matched_on: string[] }>;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ thread_id: 't-synth-0001', matched_on: ['preview'] });
    expect(output.coverage).toMatchObject({ complete: true, searchable_fields: ['participants', 'preview'] });

    const noMatch = await callTool('consumer_threads_search', { query: 'kayak' });
    expect(noMatch.matches).toEqual([]);
    expect(noMatch.truncated).toBe(false);
    // The fixture window is complete by construction, so this empty result is a definitive one;
    // the Facebook backend would report the same shape with `complete: false`.
    expect((noMatch.coverage as { complete: boolean }).complete).toBe(true);
  });
});

