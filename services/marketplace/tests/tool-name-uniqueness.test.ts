import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DenyAllAuthorizer } from '../src/authorization.js';
import { FixtureBackend } from '../src/backend.js';
import { assertUniqueToolNames, registerMarketplaceTools, TOOL_DEFINITIONS } from '../src/tools.js';

describe('tool registry name uniqueness', () => {
  it('refuses a registry that declares the same tool name twice', () => {
    const duplicated = [{ name: 'marketplace_search' }, { name: 'marketplace_fetch' }, { name: 'marketplace_search' }];

    expect(() => assertUniqueToolNames(duplicated)).toThrow('Duplicate tool name in the tool registry: marketplace_search');
  });

  it('accepts a registry whose names are distinct', () => {
    expect(() => assertUniqueToolNames([{ name: 'marketplace_search' }, { name: 'marketplace_fetch' }])).not.toThrow();
  });

  it('refuses to compile a registry that declares the same tool name twice', () => {
    const duplicated = [{ name: 'marketplace_search' }, { name: 'marketplace_search' }] as const;

    expect(() => {
      // The compile-time half of the guard is what makes a repeated name a build error. The
      // directive fails the typecheck (unused directive) once the guard stops firing, so this
      // test pins both halves: the type error and the runtime refusal of the same table.
      // @ts-expect-error a repeated tool name must not compile
      assertUniqueToolNames(duplicated);
    }).toThrow('Duplicate tool name in the tool registry: marketplace_search');
  });

  it('advertises every tool under its own name', async () => {
    const server = new Server({ name: 'tool-name-uniqueness-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    const client = new Client({ name: 'tool-name-uniqueness-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // A conversation backend that implements every conversation method keeps the gated draft and
    // send tools live, so the advertised listing covers the whole registry.
    registerMarketplaceTools(server, new FixtureBackend(), { error: vi.fn() }, {
      conversations: new FixtureBackend(),
      authorizer: new DenyAllAuthorizer()
    });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const advertised = tools.tools.map(({ name }) => name);

      // A repeated name would be advertised twice while the definition map kept one entry for
      // it, so the listing is where the collapse shows.
      expect(new Set(advertised).size).toBe(advertised.length);
      for (const name of advertised) {
        expect(Object.hasOwn(TOOL_DEFINITIONS, name)).toBe(true);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
