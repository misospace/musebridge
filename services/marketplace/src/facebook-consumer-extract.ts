import type { ExtractedMessengerSignals } from './facebook-messenger-extract.js';

// Extraction bounds for the personal-inbox menu (#79). The menu is region-scoped, so the row
// scan never walks the whole page; the bounds keep one malformed or pathological page from
// producing an unbounded payload.
export const CONSUMER_EXTRACT_LIMITS = {
  maxThreads: 20,
  maxRowsScan: 120,
  maxRowTextLength: 280
} as const;

export interface ConsumerExtractionLimits {
  maxThreads: number;
  maxRowsScan: number;
  maxRowTextLength: number;
}

export interface ExtractConsumerMenuOptions {
  limits: ConsumerExtractionLimits;
}

export interface ExtractedConsumerRow {
  threadId: string;
  route: 'plain' | 'e2ee';
  rowText?: string;
}

export interface ExtractedConsumerMenuPage {
  url: string;
  pathname: string;
  signals: ExtractedMessengerSignals;
  /** The `[aria-label="Chats"]` regions the page rendered. The verified source renders exactly
   *  one; anything else is an unrecognized layout, never a partial read. */
  chatsRegionCount: number;
  /** `[role="row"]` elements the single region rendered, whether or not they carry a conversation link. */
  regionRowCount: number;
  rows: ExtractedConsumerRow[];
  /** Rows whose only conversation link failed the key grammar. A malformed record is fail-closed
   *  evidence, never a droppable extra (#79 test plan, search-result identity). */
  malformedRows: number;
  /** Rows carrying more than one distinct conversation key. The association is ambiguous, so the
   *  whole observation fails closed rather than guessing which key is the row's (#78 fixture spec). */
  duplicateKeyRows: number;
  /** True when the region rendered more rows than the scan examined, so an unexamined row could
   *  carry a conversation the extracted rows do not show: the observation is untrusted. */
  rowsScanSaturated: boolean;
  hasEmptyStateMarker: boolean;
}

/**
 * In-page extractor for the Facebook homepage header Messenger menu. Runs inside the page after
 * the menu control has been clicked, so it cannot close over module scope: the id grammar, the
 * route pattern, and the signal collection rules are deliberately restated here and must be kept
 * in sync with `facebook-consumer-url.ts`, `domain.ts`, and `facebook-messenger-extract.ts`.
 */
export function extractConsumerMenuPage(options: ExtractConsumerMenuOptions): ExtractedConsumerMenuPage {
  const limits = options.limits;
  const boundedLimit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxRowsScan = boundedLimit(limits.maxRowsScan);
  const maxRowTextLength = boundedLimit(limits.maxRowTextLength);
  const threadIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const routePattern = /^\/messages\/(?:e2ee\/)?t\/([^/]+)\/?$/;
  const e2eePrefix = '/messages/e2ee/';
  const normalizeText = (value: string, maximum: number): string => value.replace(/\s+/g, ' ').trim().slice(0, maximum);
  const baseHref = location.href.startsWith('http://') || location.href.startsWith('https://')
    ? location.href
    : 'https://www.facebook.com/';
  const pageOrigin = location.origin === 'null' ? new URL(baseHref).origin : location.origin;
  const body = document.body ?? document.documentElement;
  const pageText = (body.textContent ?? '').slice(0, 20_000);
  const url = location.href.slice(0, 2048);
  // Captcha visibility gate (#168): restates hasVisibleCaptchaEvidence + observeSignal from
  // src/facebook.ts for the Messenger surfaces — visible structural markup or visible challenge
  // wording. An in-page function cannot close over module scope, so the rule is deliberately
  // duplicated here, exactly as the other Messenger extractors do.
  const isVisiblyRendered = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const captchaEvidenceVisible = (): boolean => {
    for (const element of document.querySelectorAll('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]')) {
      if (isVisiblyRendered(element)) return true;
    }
    const challengePhrase = /captcha|i'?m\s+not\s+a\s+robot|verify\s+you\s+are\s+a\s+human/gi;
    const parts: { start: number; end: number; element: Element }[] = [];
    let stream = '';
    const walker = document.createTreeWalker(document.body ?? document.documentElement, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.matches('script, style, template, noscript, [hidden]')) {
        stream += '\u0000';
        continue;
      }
      const value = node.textContent ?? '';
      if (!value) continue;
      if (stream.length >= 20000) break;
      parts.push({ start: stream.length, end: stream.length + value.length, element: parent });
      stream += value;
    }
    let match = challengePhrase.exec(stream);
    let cursor = 0;
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      while (cursor < parts.length) {
        const part = parts[cursor];
        if (!part || part.end <= start) {
          cursor += 1;
          continue;
        }
        break;
      }
      let covered = 0;
      let rendered = true;
      for (let index = cursor; index < parts.length; index += 1) {
        const part = parts[index];
        if (!part || part.start >= end) break;
        covered += 1;
        if (!isVisiblyRendered(part.element)) {
          rendered = false;
          break;
        }
      }
      if (covered > 0 && rendered) return true;
      if (match[0].length === 0) challengePhrase.lastIndex += 1;
      match = challengePhrase.exec(stream);
    }
    return false;
  };
  const captchaVisible = captchaEvidenceVisible();
  const signals: ExtractedMessengerSignals = {
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    hasLoginForm: document.querySelector('form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpointForm: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null,
    hasCaptchaFrame: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null,
    captchaVisible,
    hasMainLandmark: document.querySelector('main, [role="main"]') !== null,
    hasAuthenticatedMarker: document.querySelector('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]') !== null
      || Array.from(document.querySelectorAll('a')).some((anchor) => /^\s*log ?out\s*$/i.test(anchor.textContent ?? '')),
    hasLoginPrompt: Array.from(document.querySelectorAll('a, [role="link"], button, [role="button"]')).some((element) => {
      const label = element.getAttribute('aria-label') ?? element.textContent ?? '';
      return /^\s*log ?in( to facebook)?\s*$/i.test(label);
    }),
    mentionsCheckpoint: /security check|confirm your identity|unusual activity/i.test(pageText),
    mentionsCaptcha: /captcha|i'?m\s+not\s+a\s+robot|verify\s+you\s+are\s+a\s+human/i.test(pageText)
  };
  const hasEmptyStateMarker = /no conversations|no messages yet|nothing here yet/i.test(pageText);

  const result: ExtractedConsumerMenuPage = {
    url,
    pathname: location.pathname.slice(0, 512),
    signals,
    chatsRegionCount: document.querySelectorAll('[aria-label="Chats"]').length,
    regionRowCount: 0,
    rows: [],
    malformedRows: 0,
    duplicateKeyRows: 0,
    rowsScanSaturated: false,
    hasEmptyStateMarker
  };
  if (result.chatsRegionCount !== 1) return result;

  const region = document.querySelector('[aria-label="Chats"]');
  if (!region) return result;
  const rows = Array.from(region.querySelectorAll('[role="row"]'));
  result.regionRowCount = rows.length;
  result.rowsScanSaturated = rows.length > maxRowsScan;
  const scanLength = Math.min(rows.length, maxRowsScan);
  for (const row of rows.slice(0, scanLength)) {
    const keys = new Map<string, 'plain' | 'e2ee'>();
    let malformedLink = false;
    for (const link of row.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') ?? '';
      let resolved: URL;
      try {
        resolved = new URL(href, baseHref);
      } catch {
        continue;
      }
      if (resolved.origin !== pageOrigin) continue;
      const match = resolved.pathname.match(routePattern);
      if (!match || match[1] === undefined) continue;
      let threadId = match[1];
      try {
        threadId = decodeURIComponent(threadId);
      } catch {
        // Keep the raw segment; the grammar check decides it.
      }
      if (!threadId || threadId.length > 128 || !threadIdPattern.test(threadId)) {
        // A conversation-shaped link whose key fails the grammar is a malformed record, not an
        // unrelated link: the row can never be trusted as one conversation.
        malformedLink = true;
        continue;
      }
      keys.set(threadId, resolved.pathname.startsWith(e2eePrefix) ? 'e2ee' : 'plain');
    }
    if (keys.size > 1) {
      result.duplicateKeyRows += 1;
      continue;
    }
    if (keys.size === 1) {
      if (malformedLink) {
        result.malformedRows += 1;
        continue;
      }
      const entry = [...keys.entries()][0];
      if (!entry) continue;
      const [threadId, route] = entry;
      const rowText = normalizeText(row.textContent ?? '', maxRowTextLength);
      result.rows.push({ threadId, route, ...(rowText ? { rowText } : {}) });
      continue;
    }
    if (malformedLink) result.malformedRows += 1;
    // A row with no conversation link at all is not a conversation row (the menu renders header
    // and action rows too); it is excluded without reading its text into the result.
  }
  return result;
}
