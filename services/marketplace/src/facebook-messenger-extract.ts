export const MESSENGER_EXTRACT_LIMITS = {
  maxThreads: 20,
  maxThreadsScan: 60,
  maxMessages: 50,
  // The maximum number of rendered message rows a read may examine. Every examined row must be
  // examined for its own explicit timestamp, so a thread that renders more rows than this bound
  // cannot be oriented by timestamp and the read fails closed instead of guessing an end.
  maxMessagesScan: 500,
  maxTextLength: 2000,
  maxPreviewLength: 280,
  maxHrefsPerAnchor: 12
} as const;

export interface ExtractedMessengerSignals {
  hasPasswordInput: boolean;
  hasLoginForm: boolean;
  hasCheckpointForm: boolean;
  hasCaptchaFrame: boolean;
  hasMainLandmark: boolean;
  hasAuthenticatedMarker: boolean;
  hasLoginPrompt: boolean;
  mentionsCheckpoint: boolean;
  mentionsCaptcha: boolean;
}

export interface ExtractedInboxThread {
  threadId: string;
  preview?: string;
  itemId?: string;
}

export interface ExtractedInboxPage {
  url: string;
  signals: ExtractedMessengerSignals;
  hasEmptyStateMarker: boolean;
  threads: ExtractedInboxThread[];
}

export interface ExtractedMessage {
  sender?: 'you' | 'other';
  senderName?: string;
  text: string;
  sentAt?: string;
}

export interface ExtractedThreadPage {
  url: string;
  signals: ExtractedMessengerSignals;
  /** Attributed message rows found in the page, in DOM order. This is the candidate set; the
   *  newest end of the window is selected from it by explicit timestamps, never by DOM order. */
  messages: ExtractedMessage[];
  diagnostics?: {
    hasMessageLog: boolean;
    hasArticleMessages: boolean;
    hasExplicitEmptyState: boolean;
    scannedRows: number;
    unattributedRows: number;
    /** Candidates that carry no usable explicit timestamp, so the newest end is not proven. */
    undatedMessages: number;
    /** True when the page renders more rows than the scan bound, so not every rendered row could
     *  be examined and the newest end of the thread is not proven. */
    scanBoundExceeded: boolean;
    // True when the scan stopped before every row present in the DOM was examined — so rows may
    // exist outside the examined window.
    truncated: boolean;
  };
}

export interface MessengerExtractionLimits {
  maxThreads: number;
  maxThreadsScan: number;
  maxMessages: number;
  maxMessagesScan: number;
  maxTextLength: number;
  maxPreviewLength: number;
  maxHrefsPerAnchor: number;
}

export interface ExtractMessengerInboxOptions {
  threadPath: string;
  limits: MessengerExtractionLimits;
}

export interface ExtractMessengerThreadOptions {
  limits: MessengerExtractionLimits;
}

export function extractMessengerInboxPage(options: ExtractMessengerInboxOptions): ExtractedInboxPage {
  const threadPath = options.threadPath;
  const threadIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const limits = options.limits;
  const boundedLimit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxThreads = boundedLimit(limits.maxThreads);
  const maxThreadsScan = boundedLimit(limits.maxThreadsScan);
  const maxPreviewLength = boundedLimit(limits.maxPreviewLength);
  const maxHrefsPerAnchor = boundedLimit(limits.maxHrefsPerAnchor);
  const normalizeText = (value: string, maximum: number): string => value.replace(/\s+/g, ' ').trim().slice(0, maximum);
  const baseHref = location.href.startsWith('http://') || location.href.startsWith('https://')
    ? location.href
    : 'https://www.facebook.com/';
  const pageOrigin = location.origin === 'null' ? new URL(baseHref).origin : location.origin;
  const body = document.body ?? document.documentElement;
  const pageText = (body.textContent ?? '').slice(0, 20_000);
  const url = location.href.slice(0, 2048);
  // These checks mirror readFacebookPage in src/facebook.ts; an in-page function cannot close over it.
  const signals: ExtractedMessengerSignals = {
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    hasLoginForm: document.querySelector('form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpointForm: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null,
    hasCaptchaFrame: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null,
    hasMainLandmark: document.querySelector('main, [role="main"]') !== null,
    hasAuthenticatedMarker: document.querySelector('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]') !== null
      || Array.from(document.querySelectorAll('a')).some((anchor) => /^\s*log ?out\s*$/i.test(anchor.textContent ?? '')),
    hasLoginPrompt: Array.from(document.querySelectorAll('a, [role="link"], button, [role="button"]')).some((element) => {
      const label = element.getAttribute('aria-label') ?? element.textContent ?? '';
      return /^\s*log ?in( to facebook)?\s*$/i.test(label);
    }),
    mentionsCheckpoint: /security check|confirm your identity|unusual activity/i.test(pageText),
    mentionsCaptcha: /captcha|i'?m not a robot|verify you are a human/i.test(pageText)
  };
  const hasEmptyStateMarker = /no conversations|no messages yet|nothing here yet/i.test(pageText);
  const threadIds = new Set<string>();
  const threads: ExtractedInboxThread[] = [];
  const itemPattern = /^\/marketplace\/item\/(\d{5,20})(?=\/|$)/;
  const anchors = document.querySelectorAll('a[href]');
  const scanLength = Math.min(anchors.length, maxThreadsScan);
  for (let index = 0; index < scanLength && threads.length < maxThreads; index += 1) {
    const anchor = anchors[index];
    if (!anchor) continue;
    let threadUrl: URL;
    try {
      threadUrl = new URL(anchor.getAttribute('href') ?? '', baseHref);
    } catch {
      continue;
    }
    if (threadUrl.origin !== pageOrigin || !threadUrl.pathname.startsWith(threadPath)) continue;
    const threadId = threadUrl.pathname.slice(threadPath.length).split('/')[0] ?? '';
    if (threadId.length > 128 || !threadIdPattern.test(threadId) || threadIds.has(threadId)) continue;
    threadIds.add(threadId);
    const preview = normalizeText(anchor.textContent ?? '', maxPreviewLength);
    const thread: ExtractedInboxThread = { threadId, ...(preview ? { preview } : {}) };

    const hrefs: string[] = [];
    if (maxHrefsPerAnchor > 0 && anchor.matches('a[href]')) hrefs.push(anchor.getAttribute('href') ?? '');
    for (const nested of anchor.querySelectorAll('a[href]')) {
      if (hrefs.length >= maxHrefsPerAnchor) break;
      hrefs.push(nested.getAttribute('href') ?? '');
    }
    const itemIds = new Set<string>();
    for (const href of hrefs) {
      try {
        const itemUrl = new URL(href, baseHref);
        if (itemUrl.origin !== pageOrigin) continue;
        const itemId = itemUrl.pathname.match(itemPattern)?.[1];
        if (itemId) itemIds.add(itemId);
      } catch {
        // Ignore malformed links; item_id is optional and never inferred from text.
      }
    }
    if (itemIds.size === 1) thread.itemId = itemIds.values().next().value;
    threads.push(thread);
  }
  return { url, signals, hasEmptyStateMarker, threads };
}

export function extractMessengerThreadPage(options: ExtractMessengerThreadOptions): ExtractedThreadPage {
  const limits = options.limits;
  const boundedLimit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxMessagesScan = boundedLimit(limits.maxMessagesScan);
  const maxTextLength = boundedLimit(limits.maxTextLength);
  const body = document.body ?? document.documentElement;
  const pageText = (body.textContent ?? '').slice(0, 20_000);
  const url = location.href.slice(0, 2048);
  // Keep the probe selectors in lockstep with readFacebookPage in src/facebook.ts.
  const signals: ExtractedMessengerSignals = {
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    hasLoginForm: document.querySelector('form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpointForm: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null,
    hasCaptchaFrame: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null,
    hasMainLandmark: document.querySelector('main, [role="main"]') !== null,
    hasAuthenticatedMarker: document.querySelector('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]') !== null
      || Array.from(document.querySelectorAll('a')).some((anchor) => /^\s*log ?out\s*$/i.test(anchor.textContent ?? '')),
    hasLoginPrompt: Array.from(document.querySelectorAll('a, [role="link"], button, [role="button"]')).some((element) => {
      const label = element.getAttribute('aria-label') ?? element.textContent ?? '';
      return /^\s*log ?in( to facebook)?\s*$/i.test(label);
    }),
    mentionsCheckpoint: /security check|confirm your identity|unusual activity/i.test(pageText),
    mentionsCaptcha: /captcha|i'?m not a robot|verify you are a human/i.test(pageText)
  };
  const messages: ExtractedMessage[] = [];
  const messageLog = document.querySelector('[role="log"]');
  const diagnostics = {
    hasMessageLog: messageLog !== null,
    hasArticleMessages: document.querySelector('[role="log"] [role="article"]') !== null,
    hasExplicitEmptyState: /no messages yet|no conversations|nothing here yet/i.test((messageLog?.textContent ?? '').slice(0, 20_000)),
    scannedRows: 0,
    unattributedRows: 0,
    undatedMessages: 0,
    scanBoundExceeded: false,
    truncated: false
  };
  // The conversation's own rows are the evidence, so they are collected from the message log when
  // the page has one; only a page without a message log falls back to a document-wide scan.
  const rows = messageLog !== null
    ? messageLog.querySelectorAll('[role="row"]')
    : document.querySelectorAll('[role="row"]');
  // Every rendered row is examined: the newest end of the window is proven by explicit timestamps
  // on the rows themselves, so a row that was never examined could be the newest one. DOM order is
  // never used to decide which end is newest. When the page renders more rows than the scan bound,
  // a subset cannot prove the newest end, so the scan stops and reports the exceeded bound rather
  // than silently presenting a partial view as the tail.
  const scanLength = Math.min(rows.length, maxMessagesScan);
  diagnostics.scanBoundExceeded = rows.length > maxMessagesScan;
  if (diagnostics.scanBoundExceeded) diagnostics.truncated = true;
  for (let offset = 0; offset < scanLength; offset += 1) {
    const row = rows[offset];
    if (!row) continue;
    diagnostics.scannedRows += 1;
    const label = row.getAttribute('aria-label') ?? '';
    let sender: 'you' | 'other' | undefined;
    let senderName: string | undefined;
    if (/^you (?:said|sent|replied)/i.test(label)) {
      sender = 'you';
    } else {
      const otherMatch = label.match(/^([^\r\n]{1,128}?) said:/i);
      if (otherMatch) {
        sender = 'other';
        senderName = otherMatch[1]?.trim() || undefined;
      }
    }
    // Attribution is required; unknown rows are not represented as messages.
    if (!sender) {
      diagnostics.unattributedRows += 1;
      continue;
    }
    const text = (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, maxTextLength);
    if (!text) continue;
    const message: ExtractedMessage = { sender, text, ...(senderName ? { senderName } : {}) };
    const rawDate = row.querySelector('time[datetime]')?.getAttribute('datetime')?.trim();
    if (rawDate) {
      let date: Date;
      if (/^\d{12,16}$/.test(rawDate)) date = new Date(Number(rawDate));
      else date = new Date(rawDate);
      const year = date.getUTCFullYear();
      if (Number.isFinite(date.getTime()) && year >= 2000 && year <= 2100) message.sentAt = date.toISOString();
    }
    // An attributed row without a usable explicit timestamp cannot be placed in the thread's
    // timeline, so it counts against the orientation proof.
    if (!message.sentAt) diagnostics.undatedMessages += 1;
    messages.push(message);
  }
  return { url, signals, messages, diagnostics };
}

// The message composer is recognized strictly by its accessibility contract: a contenteditable
// textbox that carries an aria label. The element's text and aria-label values are intentionally
// never read or returned by this extraction, so no page content can leak through it.
export const MESSENGER_COMPOSER_SELECTOR = 'div[contenteditable="true"][role="textbox"][aria-label]';

export type MessengerComposerPresence = 'present' | 'absent' | 'ambiguous';

/**
 * Pure decision contract for the message composer: maps the number of contract composer
 * nodes to `absent` (none), `present` (exactly one), or `ambiguous` (two or more, which is
 * unsafe to target). This has no page or browser APIs, so it can be unit-tested directly and
 * is applied on the Node side after the thin in-page count.
 */
export function classifyMessengerComposerCount(composerCount: number): MessengerComposerPresence {
  if (composerCount <= 0) return 'absent';
  if (composerCount === 1) return 'present';
  return 'ambiguous';
}

/**
 * Why the newest end of a thread read window could not be established. Every reason is a
 * fail-closed condition: the read reports a typed upstream error instead of guessing an end.
 */
export type MessengerWindowUnprovenReason = 'undated_messages' | 'scan_bound_exceeded' | 'missing_diagnostics';

export type MessengerWindowOutcome =
  | { kind: 'window'; messages: ExtractedMessage[]; truncated: boolean }
  | { kind: 'unproven'; reason: MessengerWindowUnprovenReason };

/**
 * Pure decision contract for a thread read window: the newest end of the window is established
 * only by the explicit timestamps carried on the message rows themselves. DOM order is never used
 * to decide which end is newest, and the window is ordered by those timestamps rather than by
 * the order the rows happened to render in — the deployed Messenger DOM ordering is unvalidated,
 * so an ordering assumption is not a proof. Messages that share one timestamp keep their relative
 * order among themselves.
 *
 * This has no page or browser APIs, so it is unit-testable on the Node side and is applied there
 * after the thin in-page probe collects the candidates.
 */
export function selectMessengerThreadWindow(input: {
  candidates: ExtractedMessage[];
  diagnostics?: ExtractedThreadPage['diagnostics'];
  maxMessages: number;
}): MessengerWindowOutcome {
  const diagnostics = input.diagnostics;
  // An extraction that cannot report its scan bounds has proven nothing about the rows it did
  // not examine, so the coverage of the window is unknown.
  if (!diagnostics) return { kind: 'unproven', reason: 'missing_diagnostics' };
  // More rendered rows than the scan bound means at least one row was never examined, and that
  // row could carry the newest timestamp.
  if (diagnostics.scanBoundExceeded) return { kind: 'unproven', reason: 'scan_bound_exceeded' };
  // A candidate without an explicit timestamp cannot be placed on the timeline, so the newest
  // end of the thread is not proven.
  if (input.candidates.some((candidate) => !candidate.sentAt)) {
    return { kind: 'unproven', reason: 'undated_messages' };
  }
  const maxMessages = Number.isFinite(input.maxMessages) ? Math.max(0, Math.floor(input.maxMessages)) : 0;
  const byNewestFirst = [...input.candidates].sort((left, right) => {
    const leftTime = Date.parse(left.sentAt ?? '');
    const rightTime = Date.parse(right.sentAt ?? '');
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return rightTime - leftTime;
  });
  const truncated = input.candidates.length > maxMessages;
  // The window is returned oldest-first, as a conversation reads.
  return { kind: 'window', messages: byNewestFirst.slice(0, maxMessages).reverse(), truncated };
}

export interface ExtractedComposerPage {
  url: string;
  composerCount: number;
}

export interface FindMessengerComposerOptions {
  selector: string;
}

/**
 * Thin in-page count for the message composer, run via `page.evaluate`. It reports only the
 * number of contract composer nodes and the page url — no classification, no text, no
 * aria-label values. The presence decision is applied on the Node side by
 * `classifyMessengerComposerCount`, which keeps this serializable function self-contained
 * (an in-page function cannot close over module-level helpers).
 */
export function findMessengerComposer(options: FindMessengerComposerOptions): ExtractedComposerPage {
  const url = location.href.slice(0, 2048);
  const composerCount = document.querySelectorAll(options.selector).length;
  return { url, composerCount };
}
