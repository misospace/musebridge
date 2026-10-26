import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { BrowserSessionManager, type BrowserSessionOptions } from '../../src/browser.js';

export interface FakePage {
  close(): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
}

export interface FakeBrowserContext extends EventEmitter {
  readonly closed: boolean;
  readonly page: FakePage;
  close(): Promise<void>;
  browser(): null;
  pages(): FakePage[];
  newPage(): Promise<FakePage>;
}

export interface FakePlaywrightHarness {
  readonly manager: BrowserSessionManager;
  readonly contexts: FakeBrowserContext[];
  readonly profileDir: string;
}

class FakeContext extends EventEmitter implements FakeBrowserContext {
  private isClosed = false;
  readonly page: FakePage = {
    close: async () => undefined,
    goto: async () => undefined
  };

  get closed(): boolean {
    return this.isClosed;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close');
  }

  browser(): null {
    return null;
  }

  pages(): FakePage[] {
    return [this.page];
  }

  async newPage(): Promise<FakePage> {
    return this.page;
  }
}

/**
 * A browser-free browser session manager: every persistent context comes from a fake
 * Playwright, and every handed-out context is recorded so a test can observe its lifecycle.
 */
export function createFakePlaywrightHarness(options: BrowserSessionOptions = {}): FakePlaywrightHarness {
  const contexts: FakeBrowserContext[] = [];
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'marketplace-fake-browser-'));
  const manager = new class extends BrowserSessionManager {
    loadPlaywright(): Promise<typeof import('playwright')> {
      return Promise.resolve({
        chromium: {
          launchPersistentContext: async () => {
            // One serialized browser per profile scope: a second launch while a context is still
            // open means two browsers hold the same profile directory, so the fake refuses it.
            const open = contexts.find((context) => !context.closed);
            if (open) throw new Error('a second browser launch was requested while a context was still open');
            const context = new FakeContext();
            contexts.push(context);
            return context as unknown as BrowserContext;
          }
        }
      } as unknown as typeof import('playwright'));
    }
  }({ ...options, profileDir, logger: options.logger ?? { error: () => undefined } });

  return { manager, contexts, profileDir };
}
