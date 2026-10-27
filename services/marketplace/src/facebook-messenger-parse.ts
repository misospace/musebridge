import {
  conversationMessageSchema,
  conversationThreadSchema,
  type ConversationMessage,
  type ConversationReadCoverage,
  type ConversationThread,
  type ProviderErrorCode
} from './domain.js';
import {
  MESSENGER_EXTRACT_LIMITS,
  selectMessengerThreadWindow,
  type ExtractedInboxPage,
  type ExtractedMessage,
  type ExtractedThreadPage
} from './facebook-messenger-extract.js';
import { buildMessengerThreadUrl } from './facebook-messenger-url.js';
import type { MessengerInboxGraphQLObservation } from './facebook-messenger-inbox-graphql.js';

export type MessengerInboxPageKind = 'captcha' | 'checkpoint' | 'login' | 'threads' | 'empty' | 'unknown';
export type MessengerThreadPageKind = 'captcha' | 'checkpoint' | 'login' | 'messages' | 'unavailable' | 'unknown';

function isExpectedPathname(url: string, baseUrl: string, expectedPathname: (pathname: string) => boolean): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(baseUrl).origin && expectedPathname(parsed.pathname);
  } catch {
    return false;
  }
}

export function classifyMessengerInboxPage(page: ExtractedInboxPage): MessengerInboxPageKind {
  if (page.signals.hasCaptchaFrame || page.signals.mentionsCaptcha) return 'captcha';
  if (page.signals.hasCheckpointForm || page.signals.mentionsCheckpoint) return 'checkpoint';
  if (page.signals.hasPasswordInput || page.signals.hasLoginForm || page.signals.hasLoginPrompt) return 'login';
  if (page.signals.hasMainLandmark && page.signals.hasAuthenticatedMarker && page.threads.length > 0) return 'threads';
  if (page.signals.hasMainLandmark && page.signals.hasAuthenticatedMarker && page.hasEmptyStateMarker && page.threads.length === 0) return 'empty';
  return 'unknown';
}

export type MessengerInboxOutcome =
  | { kind: 'threads'; threads: ConversationThread[]; truncated: boolean }
  | { kind: 'empty' }
  | { kind: 'error'; code: ProviderErrorCode; message: string };

export function interpretMessengerInboxPage(input: {
  page: ExtractedInboxPage;
  baseUrl: string;
  inboxPath: string;
  limit: number;
  graphql?: MessengerInboxGraphQLObservation;
  // The extraction collection cap this page was read under. The backend's configured cap may be
  // smaller than the contract maximum, and the DOM-fallback completeness check must compare
  // against the cap that actually bounded the extraction, not the constant.
  maxExtractedThreads?: number;
}): MessengerInboxOutcome {
  const kind = classifyMessengerInboxPage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook login is required to read Marketplace conversations.' };
  // Navigation follows redirects, so the page that rendered may not be the page that was asked
  // for. Content is only trusted from the configured inbox address; anything else is a typed
  // error rather than data attributed to the inbox.
  const inboxPrefix = input.inboxPath.endsWith('/') ? input.inboxPath.slice(0, -1) : input.inboxPath;
  const atInbox = isExpectedPathname(input.page.url, input.baseUrl, (pathname) => pathname === inboxPrefix || pathname.startsWith(`${inboxPrefix}/`));
  if (!atInbox) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox page was not reached at the expected address.' };
  const graphql = input.graphql;
  if (graphql?.malformed) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox threads could not be parsed.' };
  // Thread ids are returned only after the collector follows the observed cursor chain from the
  // initial request through an explicit terminal page. Missing, untracked, or unlinked pages stay
  // a typed failure rather than a partial success.
  if (graphql?.incomplete) {
    return {
      kind: 'error',
      code: 'UPSTREAM_ERROR',
      message: 'The Facebook Marketplace inbox pagination could not be verified; a complete thread list cannot be returned.'
    };
  }
  if (graphql && graphql.threadIds.length > 0) {
    const threads: ConversationThread[] = [];
    for (const threadId of graphql.threadIds.slice(0, input.limit)) {
      const parsed = conversationThreadSchema.safeParse({ thread_id: threadId });
      if (parsed.success) threads.push(parsed.data);
    }
    // A verified chain is only a complete listing when nothing was left behind: ids dropped by
    // the collector cap or by the caller's limit keep the result honestly `truncated` (#151).
    if (threads.length > 0) {
      return {
        kind: 'threads',
        threads,
        truncated: graphql.truncated === true || graphql.threadIds.length > input.limit
      };
    }
  }
  if (graphql?.empty) return { kind: 'empty' };
  if (graphql?.recognized) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox threads could not be parsed.' };
  // Without a verified GraphQL connection the DOM anchors are the only remaining signal, and they
  // are trusted only when the page is a recognized authenticated inbox (never on an unknown layout).
  if (kind === 'unknown') return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox page layout was not recognized.' };
  if (kind === 'empty') return { kind: 'empty' };

  const threads: ConversationThread[] = [];
  for (const extracted of input.page.threads.slice(0, input.limit)) {
    try {
      // Rebuild against the configured origin; extracted page links never become navigation targets.
      buildMessengerThreadUrl({ baseUrl: input.baseUrl, threadId: extracted.threadId });
    } catch {
      continue;
    }
    const candidate = {
      thread_id: extracted.threadId,
      ...(extracted.preview ? { preview: extracted.preview } : {}),
      ...(extracted.itemId ? { item_id: extracted.itemId } : {})
    };
    const parsed = conversationThreadSchema.safeParse(candidate);
    if (parsed.success) threads.push(parsed.data);
  }
  if (threads.length === 0) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger inbox threads could not be parsed.' };
  }
  // The DOM fallback is a bounded recent listing, never a proven-complete one: rows dropped by
  // the caller's limit, left beyond the extractor's own collection cap, or anchors the scan
  // never reached mean more threads may exist, so the result stays honestly `truncated` (#151).
  const collectionCap = input.maxExtractedThreads ?? MESSENGER_EXTRACT_LIMITS.maxThreads;
  const truncated = input.page.threadsScanSaturated
    || input.page.threads.length > input.limit
    || input.page.threads.length >= collectionCap;
  return { kind: 'threads', threads, truncated };
}

export function classifyMessengerThreadPage(page: ExtractedThreadPage): MessengerThreadPageKind {
  if (page.signals.hasCaptchaFrame || page.signals.mentionsCaptcha) return 'captcha';
  if (page.signals.hasCheckpointForm || page.signals.mentionsCheckpoint) return 'checkpoint';
  if (page.signals.hasPasswordInput || page.signals.hasLoginForm || page.signals.hasLoginPrompt) return 'login';
  if (page.signals.hasMainLandmark && page.signals.hasAuthenticatedMarker) {
    if (page.messages.length > 0) return 'messages';
    // A rendered conversation wins over the notice text above, so notice wording inside a live
    // thread never selects this state. An authenticated page that renders an explicit
    // unavailable notice stands alone as verified absence only when the extraction report proves
    // the page rendered no message-like structure at all: no message log, no collected row
    // (even an unattributed one the probe would not read), no row rendered outside the collected
    // scope, no article or message-labelled block the row counters cannot see, and no missing
    // report that could hide any of them. A page whose report is absent or contradicts the
    // notice is an ambiguous layout and stays unknown.
    const diagnostics = page.diagnostics;
    if (
      page.hasUnavailableMarker &&
      diagnostics !== undefined &&
      !diagnostics.hasMessageLog &&
      diagnostics.renderedRows === 0 &&
      diagnostics.roleRowsOutsideScope === 0 &&
      diagnostics.messageLikeBlocks === 0
    ) return 'unavailable';
  }
  return 'unknown';
}

export type MessengerThreadOutcome =
  | { kind: 'messages'; messages: ConversationMessage[]; coverage: ConversationReadCoverage }
  | { kind: 'unavailable' }
  | { kind: 'error'; code: ProviderErrorCode; message: string };

// The window contract: the newest end of the window is established only by explicit timestamps
// on the message rows, and the rendered rows must be provably the whole message set, so a
// returned `tail` window is timestamp-proven and complete. When that proof is unavailable the
// read fails closed with a typed upstream error instead of guessing an end.
const UNPROVEN_WINDOW_MESSAGES = {
  undated_messages: 'The newest message in the Facebook Messenger thread could not be established from explicit timestamps.',
  incomplete_scan: 'The Facebook Messenger thread scan did not examine every rendered row; its newest message could not be established.',
  missing_diagnostics: 'The Facebook Messenger thread coverage could not be established.',
  missing_set_accounting: 'The Facebook Messenger thread did not report the size of its message set; its newest message could not be established.',
  incomplete_rendered_set: 'The Facebook Messenger thread rendered only part of its message set; its newest message could not be established.'
} as const;

// A message that cannot be represented means the window is not the proven window, so the read
// fails closed instead of returning a partial window as if it were complete.
const UNREPRESENTABLE_MESSAGE = 'A message in the Facebook Messenger thread window could not be represented.';

function threadReadCoverage(diagnostics: ExtractedThreadPage['diagnostics'], truncated: boolean): ConversationReadCoverage {
  return {
    window: 'tail',
    scanned_rows: diagnostics?.scannedRows ?? 0,
    truncated
  };
}

export function interpretMessengerThreadPage(input: {
  page: ExtractedThreadPage;
  baseUrl: string;
  threadId: string;
}): MessengerThreadOutcome {
  const kind = classifyMessengerThreadPage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook login is required to read Marketplace conversations.' };
  // A stale or redirected thread id can land on a different conversation. Messages are only
  // trusted from the requested thread's own address; anything else is a typed error, never
  // content attributed to the requested thread.
  const threadPrefix = `/messages/t/${input.threadId}/`;
  const atThread = isExpectedPathname(input.page.url, input.baseUrl, (pathname) => {
    const withoutTrailingSlash = threadPrefix.slice(0, -1);
    return pathname === withoutTrailingSlash || pathname === threadPrefix;
  });
  if (!atThread) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread page was not reached at the requested thread.' };
  // The observed article layout has no verified article-wide sender/content contract.
  // Even attributed rows elsewhere on this page must not be used as its conversation.
  if (input.page.diagnostics?.hasArticleMessages) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger article message layout is unsupported; sender attribution was not verified.' };
  }
  if (input.page.diagnostics?.hasExplicitEmptyState && input.page.messages.length === 0) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger empty thread layout could not be verified.' };
  }
  // A verified absence: the provider rendered an explicit deleted/unavailable/nonexistent notice
  // at the requested thread's own address, with no message content and no message log
  // contradicting it. The caller reports this as not-found (#150); auth challenges won above, a
  // redirect never reaches here, and every other unrecognized layout stays a typed error below.
  if (kind === 'unavailable') return { kind: 'unavailable' };
  if (kind === 'unknown') return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread page layout was not recognized.' };

  // The newest end of the window is selected from the candidates by their explicit timestamps.
  // Without that proof the read fails closed: an unproven orientation is never presented as the
  // newest messages of the thread. A candidate that carries no sender is not a message at all, so
  // it is dropped before the selection: it must not break the proof nor count toward truncation.
  const attributed = input.page.messages.filter(
    (candidate): candidate is ExtractedMessage & { sender: 'you' | 'other' } => candidate.sender !== undefined
  );
  const selection = selectMessengerThreadWindow({
    candidates: attributed,
    diagnostics: input.page.diagnostics,
    maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
  });
  if (selection.kind === 'unproven') {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: UNPROVEN_WINDOW_MESSAGES[selection.reason] };
  }

  const messages: ConversationMessage[] = [];
  for (const extracted of selection.messages) {
    const senderName = extracted.senderName?.trim();
    const candidate = {
      sender: extracted.sender,
      ...(senderName ? { sender_name: senderName } : {}),
      text: extracted.text,
      ...(extracted.sentAt ? { sent_at: extracted.sentAt } : {})
    };
    const parsed = conversationMessageSchema.safeParse(candidate);
    // A selected message that cannot be represented means the window is not the proven window.
    if (!parsed.success) return { kind: 'error', code: 'UPSTREAM_ERROR', message: UNREPRESENTABLE_MESSAGE };
    messages.push(parsed.data);
  }
  if (messages.length === 0) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread messages could not be parsed.' };
  }
  return { kind: 'messages', messages, coverage: threadReadCoverage(input.page.diagnostics, selection.truncated) };
}
