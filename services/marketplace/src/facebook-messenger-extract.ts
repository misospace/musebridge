export const MESSENGER_EXTRACT_LIMITS = {
  maxThreads: 20,
  maxThreadsScan: 60,
  maxMessages: 50,
  // The maximum number of rendered message rows a read may examine. Every rendered row must be
  // examined for its own explicit timestamp, so a thread that renders more rows than this bound
  // cannot be oriented by timestamp and the read fails closed instead of guessing an end.
  maxMessagesScan: 500,
  maxTextLength: 2000,
  // The maximum total candidate text a read may collect across the rows it examines. The per-row
  // bound alone would still let a page with many rows produce an unbounded payload, so the
  // collected text is bounded as well. Exceeding the budget fails the window proof closed, because
  // the rows that were not examined could carry the newest timestamp.
  maxCandidateTextLength: 512000,
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
    /** Message rows the page rendered in the scanned scope, whether or not they were examined. */
    renderedRows: number;
    /** Rows the probe actually examined. A value below `renderedRows` means a rendered row was
     *  never examined, so it could have carried the newest timestamp. */
    scannedRows: number;
    /** Rows that carried no recognizable orientation marker, so they are not messages. */
    unattributedRows: number;
    /** Attributed rows that carry no usable explicit timestamp of their own, so the newest end
     *  of the thread is not proven. */
    undatedMessages: number;
    /** True when the collected candidate text exceeded its budget. The scan may still have
     *  examined every rendered row, but the read is over its text budget, so the window it would
     *  return is not one this contract promises. */
    candidateTextBudgetExceeded: boolean;
  };
}

export interface MessengerExtractionLimits {
  maxThreads: number;
  maxThreadsScan: number;
  maxMessages: number;
  maxMessagesScan: number;
  maxTextLength: number;
  maxCandidateTextLength: number;
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
  const maxCandidateTextLength = boundedLimit(limits.maxCandidateTextLength);
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
    renderedRows: 0,
    scannedRows: 0,
    unattributedRows: 0,
    undatedMessages: 0,
    candidateTextBudgetExceeded: false
  };
  // The conversation's own rows are the evidence, so they are collected from the first message log
  // that actually renders rows; only a page without such a log falls back to a document-wide scan.
  let rowScope: ParentNode | null = null;
  for (const log of Array.from(document.querySelectorAll('[role="log"]'))) {
    if (log.querySelector('[role="row"]') !== null) {
      rowScope = log;
      break;
    }
  }
  const rows = rowScope !== null
    ? rowScope.querySelectorAll('[role="row"]')
    : document.querySelectorAll('[role="row"]');
  diagnostics.renderedRows = rows.length;
  // A row's own timestamp is the only evidence of where the row sits in the thread's timeline, so
  // it must be a direct child of the row: a timestamp on a nested element describes something else
  // (an attachment, a reaction, a quoted message) and is never borrowed for the row.
  const ownRowTimestamp = (row: Element): string | undefined => {
    const children = row.children;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child || typeof child.tagName !== 'string' || child.tagName.toLowerCase() !== 'time') continue;
      const rawDate = child.getAttribute('datetime')?.trim();
      if (!rawDate) continue;
      let date: Date;
      if (/^\d{12,16}$/.test(rawDate)) date = new Date(Number(rawDate));
      else date = new Date(rawDate);
      const year = date.getUTCFullYear();
      if (Number.isFinite(date.getTime()) && year >= 2000 && year <= 2100) return date.toISOString();
    }
    return undefined;
  };
  // Every rendered row is examined: the newest end of the window is proven by explicit timestamps
  // on the rows themselves, so a row that was never examined could be the newest one. DOM order is
  // never used to decide which end is newest. When the page renders more rows than the scan bound,
  // or when the collected text exceeds its budget, the scan stops and the rows it did not examine
  // are reported, so the newest end of the thread is not proven and the read fails closed instead
  // of silently presenting a partial view as the tail.
  const scanLength = Math.min(rows.length, maxMessagesScan);
  let collectedTextLength = 0;
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
    // Every attributed row must carry a usable explicit timestamp of its own, whether or not it
    // carries text: an attributed row without one cannot be placed on the thread's timeline, so
    // the newest end of the thread is not proven.
    const sentAt = ownRowTimestamp(row);
    if (!sentAt) diagnostics.undatedMessages += 1;
    const text = (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, maxTextLength);
    // Only an attributed row that carries text is a message; an attachment-only row is not a
    // candidate, but it still had to carry its own timestamp to keep the proof intact.
    if (!text) continue;
    const message: ExtractedMessage = {
      sender,
      text,
      ...(senderName ? { senderName } : {}),
      ...(sentAt ? { sentAt } : {})
    };
    messages.push(message);
    collectedTextLength += text.length;
    if (collectedTextLength > maxCandidateTextLength) {
      // The budget is spent: the scan stops, and the read fails closed even when this was the
      // last rendered row, because a window collected over budget is not a window this contract
      // promises to have bounded.
      diagnostics.candidateTextBudgetExceeded = true;
      break;
    }
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
export type MessengerWindowUnprovenReason = 'undated_messages' | 'incomplete_scan' | 'missing_diagnostics';

export type MessengerWindowOutcome =
  | { kind: 'window'; messages: ExtractedMessage[]; truncated: boolean }
  | { kind: 'unproven'; reason: MessengerWindowUnprovenReason };

/**
 * Pure decision contract for a thread read window: the newest end of the window is established
 * only by the explicit timestamps carried on the message rows themselves. DOM order is never used
 * to decide which end is newest, and the window is ordered by those timestamps rather than by
 * the order the rows happened to render in — the deployed Messenger DOM ordering is unvalidated,
 * so an ordering assumption is not a proof. Messages that share one timestamp keep their relative
 * order among themselves, and when the window bound cuts through such a group, which of the tied
 * messages is kept follows the order they were rendered in — the provider gave them the same
 * timestamp, so nothing distinguishes them.
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
  // An attributed row without a usable timestamp of its own cannot be placed on the timeline, so
  // the newest end of the thread is not proven.
  if (diagnostics.undatedMessages > 0) return { kind: 'unproven', reason: 'undated_messages' };
  // A rendered row that was never examined could carry the newest timestamp, so a partially
  // scanned page proves nothing about the newest end.
  if (diagnostics.scannedRows !== diagnostics.renderedRows) return { kind: 'unproven', reason: 'incomplete_scan' };
  // A read that collected more candidate text than its budget promised is not a bounded read, so
  // the window it could return is not one this contract claims.
  if (diagnostics.candidateTextBudgetExceeded) return { kind: 'unproven', reason: 'incomplete_scan' };
  // Every candidate must carry a timestamp that places it on the timeline.
  if (input.candidates.some((candidate) => !candidate.sentAt || !Number.isFinite(Date.parse(candidate.sentAt)))) {
    return { kind: 'unproven', reason: 'undated_messages' };
  }
  const maxMessages = Number.isFinite(input.maxMessages) ? Math.max(0, Math.floor(input.maxMessages)) : 0;
  // The newest candidates are selected first. Candidates that share one timestamp are ordered by
  // their reverse input position, so reversing the selected window for presentation restores
  // their original relative order among themselves.
  const byNewestFirst = input.candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.candidate.sentAt ?? '');
      const rightTime = Date.parse(right.candidate.sentAt ?? '');
      if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return right.index - left.index;
    })
    .map((entry) => entry.candidate);
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
