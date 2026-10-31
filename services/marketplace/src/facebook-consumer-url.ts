import { MAX_THREAD_ID_LENGTH } from './domain.js';
import { assertFacebookOrigin } from './facebook.js';

// The consumer discovery source is the Facebook homepage header Messenger menu (#79 evidence
// record, `docs/messenger-personal-search-design.md`): the menu opens on the root pathname
// without navigating, so the menu load targets the configured origin's root — never `/messages/`
// (whose direct navigation auto-selects a thread, #78) and never the Marketplace inbox.
export const CONSUMER_MENU_PATHNAME = '/';

// Both route forms the menu renders for conversation rows: plain and E2EE. Route provenance is
// preserved per row; an E2EE-surfaced key is never rewritten to the plain path.
export const CONSUMER_THREAD_ROUTE_PATTERN = /^\/messages\/(?:e2ee\/)?t\/([^/]+)\/?$/;
export const CONSUMER_E2EE_PREFIX = '/messages/e2ee/';

// Keep in sync with the thread id expression used by domain.ts.
export const CONSUMER_THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ConsumerMenuUrlInput {
  baseUrl: string;
}

export function buildConsumerMenuUrl(input: ConsumerMenuUrlInput): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Menu URL input is required');
  }
  const base = new URL(assertFacebookOrigin(input.baseUrl));
  const url = new URL(CONSUMER_MENU_PATHNAME, base.origin);
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Extracts the route-proven thread key and route form from a same-origin conversation link path.
 * The key must satisfy the shared thread-id grammar after percent-decoding; anything else is not
 * a conversation route and is never attributed to a thread.
 */
export function parseConsumerThreadRoute(pathname: string): { threadId: string; route: 'plain' | 'e2ee' } | undefined {
  if (typeof pathname !== 'string') return undefined;
  const match = pathname.match(CONSUMER_THREAD_ROUTE_PATTERN);
  if (!match || match[1] === undefined) return undefined;
  const route = pathname.startsWith(CONSUMER_E2EE_PREFIX) ? 'e2ee' : 'plain';
  let threadId = match[1];
  try {
    threadId = decodeURIComponent(threadId);
  } catch {
    // Keep the raw segment; the grammar check below decides it.
  }
  if (!threadId || threadId.length > MAX_THREAD_ID_LENGTH || !CONSUMER_THREAD_ID_PATTERN.test(threadId)) {
    return undefined;
  }
  return { threadId, route };
}
