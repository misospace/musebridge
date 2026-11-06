import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MautrixMetaBackend } from '../src/backend.js';
import {
  createMarketplaceService,
  parseMautrixMetaRiskAck,
  parseMessengerTransport,
  type MarketplaceService
} from '../src/service.js';

// Every variable the #195 gate and its surrounding scopes read at assembly time. Each test
// starts from a scrubbed environment so an ambient value can never satisfy or trip a gate.
const GATED_ENV_VARS = [
  'MESSENGER_TRANSPORT',
  'MAUTRIX_META_RISK_ACK',
  'MAUTRIX_META_BASE_URL',
  'MARKETPLACE_BACKEND',
  'MARKETPLACE_MESSENGER',
  'MESSENGER_PROFILE_DIR',
  'FACEBOOK_MESSENGER_PROBE_ONLY',
  'FACEBOOK_USERNAME',
  'FACEBOOK_PASSWORD',
  'SHOPPING_BACKEND',
  'EVENTS_BACKEND',
  'THREADS_BACKEND'
] as const;

function fakeMetaBackend(): MautrixMetaBackend {
  return {
    name: 'seam-mautrix-meta',
    async listThreads() {
      return { threads: [], truncated: false };
    },
    async readThread() {
      return null;
    },
    async backfillThread() {
      return null;
    }
  };
}

let services: MarketplaceService[] = [];

function track(service: MarketplaceService): MarketplaceService {
  services.push(service);
  return service;
}

function createTestService(options: Parameters<typeof createMarketplaceService>[0] = {}): MarketplaceService {
  return createMarketplaceService({ host: '127.0.0.1', port: 0, adminPort: 0, ...options });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of GATED_ENV_VARS) {
    if (process.env[name] !== undefined) vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseMessengerTransport', () => {
  it('keeps the browser transport for unset and explicit browser selection', () => {
    expect(parseMessengerTransport(undefined)).toBe('browser');
    expect(parseMessengerTransport('browser')).toBe('browser');
  });

  it('accepts the explicit mautrix-meta selection', () => {
    expect(parseMessengerTransport('mautrix-meta')).toBe('mautrix-meta');
  });

  it('refuses any other value with a typed startup failure', () => {
    for (const invalid of ['facebook', '', 'MAUTRIX-META']) {
      expect(() => parseMessengerTransport(invalid)).toThrow(RangeError);
      expect(() => parseMessengerTransport(invalid)).toThrow(/MESSENGER_TRANSPORT must be either/);
    }
  });
});

describe('parseMautrixMetaRiskAck', () => {
  it('treats unset and "0" as not acknowledged', () => {
    expect(parseMautrixMetaRiskAck(undefined)).toBe(false);
    expect(parseMautrixMetaRiskAck('0')).toBe(false);
  });

  it('accepts only the literal "1" as acknowledgement', () => {
    expect(parseMautrixMetaRiskAck('1')).toBe(true);
  });

  it('refuses any other value with a typed startup failure', () => {
    for (const invalid of ['true', '', '2']) {
      expect(() => parseMautrixMetaRiskAck(invalid)).toThrow(RangeError);
      expect(() => parseMautrixMetaRiskAck(invalid)).toThrow(/MAUTRIX_META_RISK_ACK/);
    }
  });
});

describe('mautrix-meta transport startup gate', () => {
  it('starts a default service with no metaConversations and no environment requirements', async () => {
    const service = track(createTestService());
    expect(service.metaConversations).toBeUndefined();
  });

  it('refuses the seam selection without the risk acknowledgement', () => {
    expect(() => createTestService({ messengerTransport: 'mautrix-meta' }))
      .toThrow(/MAUTRIX_META_RISK_ACK/);
  });

  it('refuses the environment selection without the risk acknowledgement', () => {
    vi.stubEnv('MESSENGER_TRANSPORT', 'mautrix-meta');
    expect(() => createTestService()).toThrow(/MAUTRIX_META_RISK_ACK/);
  });

  it('does not start the transport when only the acknowledgement is set', async () => {
    vi.stubEnv('MAUTRIX_META_RISK_ACK', '1');
    const service = track(createTestService());
    expect(service.metaConversations).toBeUndefined();
  });

  it('wires the seam backend once both gate parts are present and closes cleanly', async () => {
    const seam = fakeMetaBackend();
    const service = track(createTestService({
      messengerTransport: 'mautrix-meta',
      mautrixMetaRiskAcknowledged: true,
      metaConversations: seam
    }));
    expect(service.metaConversations).toBe(seam);
    await service.close();
    await service.close();
  });

  it('requires MAUTRIX_META_BASE_URL for the live backend once both gate parts are set via env', () => {
    vi.stubEnv('MESSENGER_TRANSPORT', 'mautrix-meta');
    vi.stubEnv('MAUTRIX_META_RISK_ACK', '1');
    expect(() => createTestService()).toThrow(/MAUTRIX_META_BASE_URL/);
  });

  it('checks the acknowledgement before the base URL when the selection is half-configured', () => {
    vi.stubEnv('MESSENGER_TRANSPORT', 'mautrix-meta');
    vi.stubEnv('MAUTRIX_META_BASE_URL', 'http://127.0.0.1:9777');
    expect(() => createTestService()).toThrow(/MAUTRIX_META_RISK_ACK/);
  });

  it('constructs the live backend over MAUTRIX_META_BASE_URL without attempting any fetch at assembly', async () => {
    vi.stubEnv('MESSENGER_TRANSPORT', 'mautrix-meta');
    vi.stubEnv('MAUTRIX_META_RISK_ACK', '1');
    vi.stubEnv('MAUTRIX_META_BASE_URL', 'http://127.0.0.1:9777');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('service assembly must not touch the network');
    });
    const service = track(createTestService());
    expect(service.metaConversations?.name).toBe('mautrix-meta');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a metaConversations seam without the transport selection', () => {
    expect(() => createTestService({ metaConversations: fakeMetaBackend() })).toThrow(TypeError);
  });

  it('refuses the experimental transport while the browser messenger scope would also start', () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'marketplace-mautrix-meta-conflict-'));
    try {
      vi.stubEnv('MESSENGER_TRANSPORT', 'mautrix-meta');
      vi.stubEnv('MAUTRIX_META_RISK_ACK', '1');
      vi.stubEnv('MARKETPLACE_BACKEND', 'facebook');
      vi.stubEnv('MARKETPLACE_MESSENGER', '1');
      vi.stubEnv('MESSENGER_PROFILE_DIR', join(profileRoot, 'messenger'));
      expect(() => createTestService({ metaConversations: fakeMetaBackend() }))
        .toThrow(/one Messenger transport/i);
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  it('starts the browser messenger scope with the same configuration minus the transport selection', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'marketplace-mautrix-meta-sanity-'));
    try {
      vi.stubEnv('MAUTRIX_META_RISK_ACK', '1');
      vi.stubEnv('MARKETPLACE_BACKEND', 'facebook');
      vi.stubEnv('MARKETPLACE_MESSENGER', '1');
      vi.stubEnv('MESSENGER_PROFILE_DIR', join(profileRoot, 'messenger'));
      const service = track(createTestService());
      expect(service.messengerBrowser).toBeDefined();
      expect(service.metaConversations).toBeUndefined();
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
    }
  });
});
