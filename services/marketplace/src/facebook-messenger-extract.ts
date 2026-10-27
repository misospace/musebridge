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
  /**
   * Whether matched captcha evidence includes something actually rendered: a visible captcha
   * structural element or visible text matching the challenge grammar (like the probe's
   * `hasVisibleCaptchaEvidence` for the Messenger surface, this surface counts visible
   * "captcha" wording too — #85). A dormant widget or hidden copy keeps the page out of
   * `captcha` (issue #168), mirroring the probe's visibility gate (#148). Absent only on
   * hand-built legacy snapshots, where the conservative captcha verdict is kept.
   */
  captchaVisible?: boolean;
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
  /** True when the page rendered more candidate anchors than the thread scan examined, so the
   *  scan stopped at its bound with anchors left unread. An unread anchor could carry a thread
   *  row, so the extracted threads are not proven to be everything the page offers: the listing
   *  built from this page must never present itself as a complete one (#151). When the
   *  collection cap stopped the scan first, this stays `false` and the cap itself carries the
   *  `truncated` claim — the consumer must compare against the same cap the scan ran under,
   *  as `interpretMessengerInboxPage`'s `maxExtractedThreads` input does. */
  threadsScanSaturated: boolean;
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
  /** True when the page renders one of the provider's explicit deleted/unavailable/nonexistent
   *  notices in place of a conversation. Like the listing page's unavailable notice, it is only
   *  ever consulted when the page renders no message content: a rendered conversation always
   *  wins over notice text elsewhere on the page. */
  hasUnavailableMarker: boolean;
  /** Attributed message rows found in the page, in DOM order. This is the candidate set; the
   *  newest end of the window is selected from it by explicit timestamps, never by DOM order. */
  messages: ExtractedMessage[];
  diagnostics?: {
    hasMessageLog: boolean;
    hasArticleMessages: boolean;
    hasExplicitEmptyState: boolean;
    /** Message-like structure the row counters cannot see: `article` elements and
     *  `role="article"` nodes anywhere on the page — the accessibility element of a single
     *  message — and elements that are not recognized rows but whose `aria-label` carries the
     *  message row's attribution grammar ("You said ...", "... said: ..."). A notice cannot
     *  disprove a rendered block of this kind, so verified absence requires the count to be
     *  zero: a page whose unavailable wording is wrapped in message-like structure is an
     *  ambiguous layout, never a proven deletion. */
    messageLikeBlocks: number;
    /** The scope the message rows were collected from: the page's message log (`message_log`),
     *  the one container that holds the rendered rows (`page_container`), no scope at all
     *  because the page rendered no rows at all — no log and no row (`none`), or no trusted scope
     *  because the page offered more than one candidate (`ambiguous`). A message log that
     *  renders no row is still a `message_log` scope: it names the conversation even though it
     *  holds no row. */
    rowScope: 'message_log' | 'page_container' | 'none' | 'ambiguous';
    /** How many `[role="row"]` elements the page rendered OUTSIDE the collected scope. It is a
     *  count only: no row outside the scope is read, so it can never carry page content into a
     *  read. It is the total number of rendered rows when there is no scope at all. */
    roleRowsOutsideScope: number;
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
    /** The total number of items the page declares for the rendered message set, taken from the
     *  accessibility set accounting (`aria-setsize` on the message log or on its rows, and
     *  `aria-rowcount` on a grid, table or treegrid). Absent when the page declares no usable set
     *  size — a value of `-1` means "unknown" and any non-integer is unusable — and then the
     *  rendered rows cannot be proven to be the whole thread, because a virtualized log can
     *  render only a subset of it. */
    declaredSetSize?: number;
    /** True when the scope declares more than one size, which means it holds more than one set:
     *  the container's counter and the rows' own declarations describe different sets. */
    setSizeConflict: boolean;
    /** Rows that attest that they belong to the declared set, by declaring that set's size or —
     *  when every rendered row declares a position — by declaring a position inside it. A row
     *  that attests nothing belongs to another set, so it cannot be counted toward the set's
     *  completeness. */
    attestedRows: number;
    /** Rows that declared a position within the set (`aria-posinset`). */
    positionedRows: number;
    /** The largest position the rows declared, when any row declared one. */
    newestPosition?: number;
    /** How many distinct positions the rows declared. A value below `positionedRows` means two
     *  rows claimed the same position, so the set accounting contradicts itself. */
    distinctPositions: number;
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
  // Captcha visibility gate (#168): restates hasVisibleCaptchaEvidence + observeSignal from
  // src/facebook.ts for the Messenger surface — visible structural markup or visible challenge
  // wording (this surface counts visible "captcha" text too, #85). An in-page function cannot
  // close over module scope, so the rule is deliberately duplicated here.
  const isVisiblyRendered = (element: Element): boolean => {
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
    const challengePhrase = /captcha|i'?m not a robot|verify you are a human/i;
    const walker = document.createTreeWalker(document.body ?? document.documentElement, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent && challengePhrase.test(node.textContent) && node.parentElement && isVisiblyRendered(node.parentElement)) return true;
    }
    return false;
  };
  // These checks mirror readFacebookPage in src/facebook.ts; an in-page function cannot close over it.
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
  // The scan bound is evidence, not an implementation detail: when anchors were left unread, a
  // thread row may exist beyond the bound, so the page records that its extracted threads are
  // not proven to be the whole inbox.
  const threadsScanSaturated = anchors.length > maxThreadsScan;
  return { url, signals, hasEmptyStateMarker, threads, threadsScanSaturated };
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
  // Captcha visibility gate (#168): same restatement as in extractMessengerInboxPage — the probe's
  // Messenger-surface rule counts visible structural markup or visible challenge wording, and an
  // in-page function cannot close over module scope.
  const isVisiblyRendered = (element: Element): boolean => {
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
    const challengePhrase = /captcha|i'?m not a robot|verify you are a human/i;
    const walker = document.createTreeWalker(document.body ?? document.documentElement, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent && challengePhrase.test(node.textContent) && node.parentElement && isVisiblyRendered(node.parentElement)) return true;
    }
    return false;
  };
  // Keep the probe selectors in lockstep with readFacebookPage in src/facebook.ts.
  const signals: ExtractedMessengerSignals = {
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    hasLoginForm: document.querySelector('form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpointForm: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null,
    hasCaptchaFrame: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null,
    captchaVisible: captchaEvidenceVisible(),
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
  // The provider's own statement that this conversation is gone: an explicit unavailable,
  // deleted, or nonexistent notice. The phrase list stays deliberately narrow, and the decision
  // side consults it only when no message content rendered (see classifyMessengerThreadPage), so
  // seller text quoting one of these phrases inside a live conversation never selects the state.
  const hasUnavailableMarker = /this (?:content|conversation|thread) (?:isn'?t|is not|is no longer|is currently not) available|(?:this )?content (?:is |was )?(?:currently |no longer )?unavailable|content (?:not found|was not found)|you (?:can'?t|cannot) access this (?:content|conversation|thread)|(?:this |the )?page (?:not found|wasn'?t found|doesn'?t exist|does not exist)/i.test(pageText);
  const messages: ExtractedMessage[] = [];
  const messageLog = document.querySelector('[role="log"]');
  // The accessibility set accounting is the only observable statement of how many items the
  // message set holds. A virtualized log can render just a window of that set — including a
  // window that omits the newest messages entirely — so the rendered rows are only the whole
  // thread when the page's own accounting says so.
  const declaredCount = (value: string | null | undefined, minimum: number): number | undefined => {
    if (value === null || value === undefined) return undefined;
    const trimmed = value.trim();
    // `-1` is the ARIA "unknown size" marker and any non-integer is unusable, so neither can
    // stand in for a declared size.
    if (!/^\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) return undefined;
    return parsed;
  };
  const diagnostics = {
    hasMessageLog: messageLog !== null,
    hasArticleMessages: document.querySelector('[role="log"] [role="article"]') !== null,
    hasExplicitEmptyState: /no messages yet|no conversations|nothing here yet/i.test((messageLog?.textContent ?? '').slice(0, 20_000)),
    messageLikeBlocks: 0,
    rowScope: 'none' as 'message_log' | 'page_container' | 'none' | 'ambiguous',
    roleRowsOutsideScope: 0,
    renderedRows: 0,
    scannedRows: 0,
    unattributedRows: 0,
    undatedMessages: 0,
    candidateTextBudgetExceeded: false,
    declaredSetSize: undefined as number | undefined,
    setSizeConflict: false,
    attestedRows: 0,
    positionedRows: 0,
    newestPosition: undefined as number | undefined,
    distinctPositions: 0
  };
  // The conversation's own rows are the evidence, so they are collected from exactly one scope:
  // the page's message log when it renders rows, and otherwise the one container that holds the
  // rendered rows. A document-wide collection would take an unrelated widget row for a message,
  // so a page that offers more than one candidate scope yields no rows at all and the read fails
  // closed instead of guessing which rows are the conversation. A row that declares a set size
  // proves only that it belongs to some set, never that the set is the message set, so no set
  // declaration selects the scope.
  let rowScope: Element | null = null;
  let rowScopeKind: 'message_log' | 'page_container' | 'none' | 'ambiguous' = 'none';
  const logs = Array.from(document.querySelectorAll('[role="log"]'));
  const logsWithRows = logs.filter((log) => log.querySelector('[role="row"]') !== null);
  if (logsWithRows.length === 1) {
    // One message log renders the conversation's rows, so it is the scope and the rows the page
    // rendered beside it are not part of the conversation.
    rowScope = logsWithRows[0] ?? null;
    rowScopeKind = 'message_log';
  } else if (logsWithRows.length > 1) {
    // More than one log renders rows, so no log can be told apart as the conversation: nothing
    // is collected and the read fails closed.
    rowScopeKind = 'ambiguous';
  } else if (logs.length > 0) {
    // A message log that renders no rows still names the conversation, so a row the page
    // rendered beside it is not part of it and is not collected.
    rowScope = logs[0] ?? null;
    rowScopeKind = 'message_log';
  } else {
    // Without a message log the rendered rows are the conversation, and they are collected from
    // the one container that holds them: the nearest common ancestor of every rendered row.
    const documentRows = Array.from(document.querySelectorAll('[role="row"]'));
    const firstRow = documentRows[0];
    if (!firstRow) {
      // The page rendered no rows at all, so there is nothing to collect.
      rowScopeKind = 'none';
    } else {
      // The nearest common ancestor of the rows is the one container that holds them all.
      let common: Element | null = firstRow.parentElement;
      while (common !== null) {
        const candidate = common;
        if (documentRows.every((row) => candidate.contains(row))) break;
        common = candidate.parentElement;
      }
      if (common !== null && common !== document.body && common !== document.documentElement) {
        rowScope = common;
        rowScopeKind = 'page_container';
      } else {
        // The rows share no container other than the document itself, so they are only trusted
        // when they all sit in the same parent: that parent is then the one container that
        // holds them. A page that spreads them over several parents offers more than one
        // candidate scope, so nothing is collected and the read fails closed.
        const sharedParent = documentRows.every((row) => row.parentElement === firstRow.parentElement)
          ? firstRow.parentElement
          : null;
        if (sharedParent !== null) {
          rowScope = sharedParent;
          rowScopeKind = 'page_container';
        } else {
          rowScopeKind = 'ambiguous';
        }
      }
    }
  }
  const rows: Element[] = rowScope !== null ? Array.from(rowScope.querySelectorAll('[role="row"]')) : [];
  diagnostics.rowScope = rowScopeKind;
  diagnostics.renderedRows = rows.length;
  // The rows the page rendered outside the collected scope are counted but never read: they are
  // the rows a document-wide collection would have taken, and the count says how much of the
  // page the scope does not cover.
  diagnostics.roleRowsOutsideScope = document.querySelectorAll('[role="row"]').length - rows.length;
  // Message-like structure the row counters cannot see: article/message-role nodes, and elements
  // that are not recognized rows but carry the message row's attribution grammar in their own
  // `aria-label` — everything but the role attribute of a message row. The scan reads only the
  // attribute, like the authentication-marker scan above, so it is exhaustive over the document.
  diagnostics.messageLikeBlocks = document.querySelectorAll('article, [role="article"]').length;
  const labelledElements = document.querySelectorAll('[aria-label]');
  for (let index = 0; index < labelledElements.length; index += 1) {
    const element = labelledElements[index];
    if (!element || element.getAttribute('role') === 'row') continue;
    // An article is already counted by the selector above, so its own label counts it once.
    if (element.matches('article, [role="article"]')) continue;
    const label = element.getAttribute('aria-label') ?? '';
    if (/^you (?:said|sent|replied)/i.test(label) || /^[^\r\n]{1,128} said:/i.test(label)) {
      diagnostics.messageLikeBlocks += 1;
    }
  }
  // Every declared size for this scope must agree: the container's counter and the rows' own
  // declarations describe the same set, so two different values mean the scope holds more than
  // one set and nothing here can be certified.
  const declaredSetSizes: number[] = [];
  // Only the message log counts as the set container: it is the conversation's own container,
  // and it may declare the size of the set it holds. A plain container is not a set container,
  // so its own counter says nothing about the message set and is never read.
  if (rowScopeKind === 'message_log' && rowScope) {
    const containerSetSize = declaredCount(rowScope.getAttribute('aria-setsize'), 0);
    if (containerSetSize !== undefined) declaredSetSizes.push(containerSetSize);
    // The standard container counter for a row set is `aria-rowcount` on a grid, table or
    // treegrid; `role="log"` is a live region and carries no set semantics of its own.
    const containerRowCount = declaredCount(rowScope.getAttribute('aria-rowcount'), 0);
    if (containerRowCount !== undefined) declaredSetSizes.push(containerRowCount);
  }
  const rowSetSizes: (number | undefined)[] = [];
  const rowPositions: (number | undefined)[] = [];
  const positions = new Set<number>();
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
    // Each row may also declare the size of the set it belongs to and its own position in it.
    // The declared size is the only statement of how many messages the thread holds, so it is
    // collected here rather than inferred from the rows that happened to be rendered.
    const rowSetSize = declaredCount(row.getAttribute('aria-setsize'), 0);
    if (rowSetSize !== undefined) declaredSetSizes.push(rowSetSize);
    rowSetSizes.push(rowSetSize);
    // A row's parent is the container that counts a grid-like set, so the container's
    // `aria-rowcount` is its own statement of how many items that set holds.
    const parentRowCount = declaredCount(row.parentElement?.getAttribute('aria-rowcount') ?? null, 0);
    if (parentRowCount !== undefined) declaredSetSizes.push(parentRowCount);
    const position = declaredCount(row.getAttribute('aria-posinset'), 1);
    rowPositions.push(position);
    if (position !== undefined) {
      diagnostics.positionedRows += 1;
      positions.add(position);
      if (diagnostics.newestPosition === undefined || position > diagnostics.newestPosition) {
        diagnostics.newestPosition = position;
      }
    }
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
  diagnostics.distinctPositions = positions.size;
  // The declared size is usable only when the page states one and states the same one for the
  // container and for the rows: two different sizes mean the scope holds more than one set, and
  // nothing in it can be certified as the whole message set.
  const uniqueSetSizes = Array.from(new Set(declaredSetSizes));
  if (uniqueSetSizes.length === 1) {
    diagnostics.declaredSetSize = uniqueSetSizes[0];
  } else if (uniqueSetSizes.length > 1) {
    diagnostics.setSizeConflict = true;
  }
  // A row attests that it belongs to the declared set by declaring that set's size itself, or —
  // when every rendered row declares a position — by declaring a position inside the set. A row
  // that attests nothing belongs to some other set (or to a set of unknown membership), so it can
  // never be counted toward the set's completeness.
  const declaredSize = diagnostics.declaredSetSize;
  const everyRowPositioned = rowPositions.length === diagnostics.scannedRows
    && rowPositions.every((position) => position !== undefined);
  let attestedRows = 0;
  for (let index = 0; index < rowSetSizes.length; index += 1) {
    const rowSetSize = rowSetSizes[index];
    const position = rowPositions[index];
    const attestsBySize = rowSetSize !== undefined && rowSetSize === declaredSize;
    const attestsByPosition = declaredSize !== undefined
      && everyRowPositioned
      && position !== undefined
      && position <= declaredSize;
    if (attestsBySize || attestsByPosition) attestedRows += 1;
  }
  diagnostics.attestedRows = attestedRows;
  return { url, signals, hasUnavailableMarker, messages, diagnostics };
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
export type MessengerWindowUnprovenReason =
  | 'undated_messages'
  | 'incomplete_scan'
  | 'missing_diagnostics'
  | 'missing_set_accounting'
  | 'incomplete_rendered_set';

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
 * The rendered rows must also be provably the whole message set: a virtualized log can render a
 * window of the thread that omits the newest messages entirely, and examining every rendered row
 * proves only that the rendered subset was examined. The page's own accessibility set accounting
 * is the observable statement of how many items the set holds, so a window is only certified when
 * the page declares one size for the scope, every rendered row attests that it belongs to that
 * set, the rendered rows are as many as the declared set, and the declared positions agree.
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
  // Two different declared sizes for the same scope mean it holds more than one set, so the
  // rendered rows cannot be read as the whole message set.
  if (diagnostics.setSizeConflict) return { kind: 'unproven', reason: 'incomplete_rendered_set' };
  // Without the page's own statement of how many items the message set holds, the rendered rows
  // are just a subset of it: a virtualized log renders a window of the thread, and that window
  // can omit the newest messages. A subset that happens to be internally complete is still not
  // the thread's newest end, so the read fails closed instead of certifying a `tail` window.
  if (diagnostics.declaredSetSize === undefined) return { kind: 'unproven', reason: 'missing_set_accounting' };
  // Every rendered row must attest that it belongs to the declared set. A row that attests
  // nothing belongs to another set — a nested list, a grid of unrelated rows — so counting it
  // would let a subset satisfy the declared size by coincidence.
  if (diagnostics.attestedRows !== diagnostics.renderedRows) {
    return { kind: 'unproven', reason: 'incomplete_rendered_set' };
  }
  // The declared set size and the rendered rows must agree, so the rows the read examined are the
  // whole set. A declared size above the rendered rows is the virtualized-subset case: the
  // messages the read cannot see may include the newest one.
  if (diagnostics.declaredSetSize !== diagnostics.renderedRows) {
    return { kind: 'unproven', reason: 'incomplete_rendered_set' };
  }
  // When the rows also declare their position in the set, that accounting must agree with the
  // declared size: distinct positions, and the newest position at the end of the set. A set size
  // that counts fewer items than the rows carry is a stale or fabricated count.
  if (diagnostics.positionedRows > 0) {
    if (diagnostics.distinctPositions !== diagnostics.positionedRows) {
      return { kind: 'unproven', reason: 'incomplete_rendered_set' };
    }
    if (diagnostics.newestPosition !== diagnostics.declaredSetSize) {
      return { kind: 'unproven', reason: 'incomplete_rendered_set' };
    }
  }
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
