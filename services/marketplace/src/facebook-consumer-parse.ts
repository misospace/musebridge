import { consumerThreadSchema, type ConsumerThread, type ProviderErrorCode } from './domain.js';
import { CONSUMER_MENU_PATHNAME } from './facebook-consumer-url.js';
import type { ExtractedConsumerMenuPage } from './facebook-consumer-extract.js';

export type ConsumerMenuPageKind = 'captcha' | 'checkpoint' | 'login' | 'menu' | 'empty' | 'unknown';

function isExpectedPathname(url: string, baseUrl: string, expectedPathname: (pathname: string) => boolean): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(baseUrl).origin && expectedPathname(parsed.pathname);
  } catch {
    return false;
  }
}

export function classifyConsumerMenuPage(page: ExtractedConsumerMenuPage): ConsumerMenuPageKind {
  // Same visible-evidence gate as the other Messenger surfaces (#168): dormant captcha markup or
  // hidden copy is neither a challenge nor trusted content — `unknown`, never a menu success.
  if (page.signals.hasCaptchaFrame || page.signals.mentionsCaptcha) {
    return page.signals.captchaVisible === false ? 'unknown' : 'captcha';
  }
  if (page.signals.hasCheckpointForm || page.signals.mentionsCheckpoint) return 'checkpoint';
  if (page.signals.hasPasswordInput || page.signals.hasLoginForm || page.signals.hasLoginPrompt) return 'login';
  // The verified source renders exactly one Chats region; zero or several is an unrecognized
  // layout, never a partial read (#79 evidence record).
  if (page.chatsRegionCount !== 1) return 'unknown';
  // A positively verified empty menu: the region rendered with no rows at all and an explicit
  // empty-state marker. A region with rows but no conversation among them, or without the
  // marker, may still be mid-render — it stays unknown and the settle window decides.
  if (page.rows.length === 0) {
    return page.hasEmptyStateMarker && page.regionRowCount === 0 ? 'empty' : 'unknown';
  }
  return 'menu';
}

export type ConsumerMenuOutcome =
  | { kind: 'menu'; threads: ConsumerThread[]; truncated: boolean; threadsObserved: number }
  | { kind: 'empty' }
  | { kind: 'error'; code: ProviderErrorCode; message: string };

const CONSUMER_UNTRUSTED_MESSAGE = 'The Facebook Messenger menu could not be read as a verified conversation list.';

export function interpretConsumerMenuPage(input: {
  page: ExtractedConsumerMenuPage;
  baseUrl: string;
  limit: number;
  maxExtractedThreads: number;
}): ConsumerMenuOutcome {
  const kind = classifyConsumerMenuPage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  // Re-targeted wording: the Marketplace tools' login message names Marketplace conversations, so
  // the consumer tools neutralize theirs rather than reusing it verbatim (#78 observable errors).
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook login is required to read Messenger conversations.' };
  // Containment before trust. The menu opens on the configured origin's root without navigating;
  // if the load left the root — a `/messages/t/` route in particular — the operation ends here as
  // a typed error and the selected conversation is never inspected. The error makes no claim
  // about whether a receipt was prevented or emitted: containment is not prevention (#79 record).
  const leftForThread = (() => {
    try {
      const parsed = new URL(input.page.url);
      return parsed.pathname.startsWith('/messages/');
    } catch {
      return false;
    }
  })();
  const atRoot = isExpectedPathname(input.page.url, input.baseUrl, (pathname) => pathname === CONSUMER_MENU_PATHNAME);
  if (!atRoot) {
    return {
      kind: 'error',
      code: 'UPSTREAM_ERROR',
      message: leftForThread
        ? 'The Facebook Messenger menu load navigated into a conversation; the read was aborted without inspecting it.'
        : 'The Facebook Messenger menu was not reached at the expected address.'
    };
  }
  if (kind === 'unknown') return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger menu layout was not recognized.' };
  // Untrusted observation: rows the scan never examined, rows whose links contradict each other,
  // or rows whose conversation key fails the grammar mean the window itself cannot be trusted —
  // the operation returns no results rather than a scoped success (reconciled #79 taxonomy).
  if (input.page.rowsScanSaturated || input.page.duplicateKeyRows > 0 || input.page.malformedRows > 0) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: CONSUMER_UNTRUSTED_MESSAGE };
  }
  if (kind === 'empty') return { kind: 'empty' };

  // Deduplicate by first occurrence: the same key observed twice is one conversation (#78 fixture
  // spec). Rows arrive in the provider's own presentation order; that order is preserved and is
  // never presented as recency or completeness.
  const seen = new Set<string>();
  const unique = input.page.rows.filter((row) => {
    if (seen.has(row.threadId)) return false;
    seen.add(row.threadId);
    return true;
  });
  const threadsObserved = unique.length;
  const threads: ConsumerThread[] = [];
  for (const row of unique.slice(0, input.limit)) {
    const candidate = {
      thread_id: row.threadId,
      route: row.route,
      ...(row.rowText ? { preview: row.rowText } : {})
    };
    const parsed = consumerThreadSchema.safeParse(candidate);
    // A row that cannot be represented means the window is not the verified window: fail closed
    // rather than shipping a pruned result as if it were the observation.
    if (!parsed.success) return { kind: 'error', code: 'UPSTREAM_ERROR', message: CONSUMER_UNTRUSTED_MESSAGE };
    threads.push(parsed.data);
  }
  // Cap truth: counted-but-unreturned keys are what make `truncated` honest (#151 rule). Window
  // truth is `coverage.complete`, which the Facebook backend holds permanently `false` — the menu
  // source exposes no pagination signal, so the window is never proven to be the whole inbox.
  return { kind: 'menu', threads, truncated: threadsObserved > threads.length, threadsObserved };
}
