import { readFileSync, existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  extractMessengerInboxPage,
  extractMessengerThreadPage,
  MESSENGER_EXTRACT_LIMITS,
  classifyMessengerComposerCount,
  selectMessengerThreadWindow
} from '../src/facebook-messenger-extract.js';
import { MESSENGER_THREAD_PATH } from '../src/facebook-messenger-url.js';
import { classifyMessengerInboxPage, classifyMessengerThreadPage } from '../src/facebook-messenger-parse.js';
import type { ExtractedThreadPage } from '../src/facebook-messenger-extract.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

let browser: Browser;
let page: Page;

describe.skipIf(!browserAvailable)('Facebook Messenger page extraction', () => {
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.route('**/*', async (route) => {
      // Static synthetic markup only; no request is permitted to escape the local browser.
      await route.abort();
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('extracts synthetic inbox threads, previews, and a unique listing id', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/inbox-normal.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    expect(extracted.signals.hasMainLandmark).toBe(true);
    expect(extracted.signals.hasAuthenticatedMarker).toBe(true);
    expect(extracted.threads).toEqual([
      { threadId: '1684432532', preview: 'Synthetic Seller: Is the desk available?' },
      { threadId: '1684432533', preview: 'Sample Buyer: Thanks for the details.Listing details', itemId: '123456789' },
      { threadId: '1684432534', preview: 'Example Seller: Pickup works tomorrow.' }
    ]);
    expect(classifyMessengerInboxPage(extracted)).toBe('threads');
  });

  it('recognizes only an explicit empty state and leaves a changed layout unknown', async () => {
    const emptyHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-empty.html', import.meta.url), 'utf8');
    await page.setContent(emptyHtml, { waitUntil: 'domcontentloaded' });
    const empty = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    expect(empty.hasEmptyStateMarker).toBe(true);
    expect(classifyMessengerInboxPage(empty)).toBe('empty');

    const changedHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-layout-changed.html', import.meta.url), 'utf8');
    await page.setContent(changedHtml, { waitUntil: 'domcontentloaded' });
    const changed = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    expect(changed.hasEmptyStateMarker).toBe(false);
    expect(classifyMessengerInboxPage(changed)).toBe('unknown');
  });

  it('extracts only attributed text messages, sender names, and bounded valid dates', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/thread-normal.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.messages).toEqual([
      { sender: 'other', senderName: 'Synthetic Seller', text: 'Hello there.10:30', sentAt: '2026-09-14T10:30:00.000Z' },
      { sender: 'you', text: 'Is the desk available?10:31', sentAt: '2026-09-14T10:31:00.000Z' },
      { sender: 'other', senderName: 'Synthetic Seller', text: 'Yes, it is available.10:32', sentAt: '2026-09-14T10:32:00.000Z' },
      { sender: 'other', senderName: 'Example Buyer', text: 'Could I pick it up tomorrow?10:33', sentAt: '2026-09-14T10:33:00.000Z' }
    ]);
    expect(extracted.diagnostics).toEqual({
      hasMessageLog: false,
      hasArticleMessages: false,
      hasExplicitEmptyState: false,
      scannedRows: 6,
      unattributedRows: 1,
      undatedMessages: 0,
      scanBoundExceeded: false,
      truncated: false
    });
    expect(classifyMessengerThreadPage(extracted)).toBe('messages');
  });

  it('collects every attributed candidate and lets the window selection bound the messages', async () => {
    const inboxHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      Array.from({ length: 8 }, (_, index) => `<a href="/messages/t/${1000 + index}/">${'P'.repeat(50)}</a>`).join('') + '</main></body></html>';
    await page.setContent(inboxHtml, { waitUntil: 'domcontentloaded' });
    const inbox = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: { ...MESSENGER_EXTRACT_LIMITS, maxThreads: 2, maxPreviewLength: 12 }
    });
    expect(inbox.threads).toHaveLength(2);
    expect(inbox.threads[0]?.preview).toHaveLength(12);

    const threadHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      Array.from({ length: 8 }, (_, index) => `<div role="row" aria-label="Synthetic Seller said: ${index}">Message ${index}<time datetime="2026-09-14T10:0${index}:00Z"></time></div>`).join('') + '</main></body></html>';
    await page.setContent(threadHtml, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // Every rendered row is examined and every attributed row is a candidate: the probe collects
    // evidence, it does not choose the window, so no DOM-order assumption can leak into it.
    expect(extracted.messages).toHaveLength(8);
    expect(extracted.diagnostics?.scannedRows).toBe(8);
    expect(extracted.diagnostics?.undatedMessages).toBe(0);
    expect(extracted.diagnostics?.scanBoundExceeded).toBe(false);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: 3
    });
    expect(window).toEqual({
      kind: 'window',
      messages: [
        { sender: 'other', senderName: 'Synthetic Seller', text: 'Message 5', sentAt: '2026-09-14T10:05:00.000Z' },
        { sender: 'other', senderName: 'Synthetic Seller', text: 'Message 6', sentAt: '2026-09-14T10:06:00.000Z' },
        { sender: 'other', senderName: 'Synthetic Seller', text: 'Message 7', sentAt: '2026-09-14T10:07:00.000Z' }
      ],
      truncated: true
    });
  });

  it('anchors the window on the timestamp-newest message even when the DOM order is newest-first', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span><div role="log">' +
      '<div role="row" aria-label="Synthetic Seller said: newest">Newest reply<time datetime="2026-09-14T12:00:00Z"></time></div>' +
      '<div role="row" aria-label="Synthetic Seller said: oldest">Oldest reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The probe reports the candidates in DOM order; it never decides which end is newest.
    expect(extracted.messages.map((message) => message.text)).toEqual(['Newest reply', 'Oldest reply']);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({
      kind: 'window',
      messages: [
        { sender: 'other', senderName: 'Synthetic Seller', text: 'Oldest reply', sentAt: '2026-09-14T10:00:00.000Z' },
        { sender: 'other', senderName: 'Synthetic Seller', text: 'Newest reply', sentAt: '2026-09-14T12:00:00.000Z' }
      ],
      truncated: false
    });
  });

  it('collects the conversation rows from the message log and ignores unrelated widget rows', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="Synthetic Seller said: unrelated">Unrelated widget row<time datetime="2026-09-14T13:00:00Z"></time></div>' +
      '<div role="log"><div role="row" aria-label="Synthetic Seller said: conversation">Conversation reply<time datetime="2026-09-14T10:00:00Z"></time></div></div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.diagnostics?.hasMessageLog).toBe(true);
    expect(extracted.messages.map((message) => message.text)).toEqual(['Conversation reply']);
    expect(extracted.diagnostics?.scannedRows).toBe(1);
  });

  it('reports an undated candidate instead of proving a window', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="Synthetic Seller said: dated">Dated reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-label="Synthetic Seller said: undated">Undated reply</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.messages).toHaveLength(2);
    expect(extracted.diagnostics?.undatedMessages).toBe(1);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'undated_messages' });
  });

  it('does not attribute the observed article layout or its token-bearing content', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/thread-articles-unattributed.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.signals.hasMainLandmark).toBe(true);
    expect(extracted.signals.hasAuthenticatedMarker).toBe(true);
    expect(extracted.messages).toEqual([]);
    expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
    // The message log holds the conversation, so the unrelated navigation row outside it is not
    // part of the evidence the window is proven from.
    expect(extracted.diagnostics).toEqual({
      hasMessageLog: true, hasArticleMessages: true, hasExplicitEmptyState: false,
      scannedRows: 0, unattributedRows: 0, undatedMessages: 0, scanBoundExceeded: false, truncated: false
    });
  });

  it('keeps empty and attachment-only thread layouts unknown without verified contracts', async () => {
    for (const content of [
      '<div role="log">No messages yet</div>',
      '<div role="row" aria-label="You sent an attachment"></div>'
    ]) {
      await page.setContent(`<main><span aria-label="Your account">Synthetic account</span>${content}</main>`);
      const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
      expect(extracted.messages).toEqual([]);
      expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
    }
  });

  it('preserves synthetic bracketed tokens only inside the bounded attributed text window', async () => {
    const token = '[synthetic-reply-token]';
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      `<div role="row" aria-label="You said: synthetic">Own reply ${token}</div>` +
      `<div role="row" aria-label="Synthetic Seller said: synthetic">Quoted ${token}</div>` +
      `<div role="row" aria-label="You said: synthetic">${'X'.repeat(MESSENGER_EXTRACT_LIMITS.maxTextLength)}${token}</div>` +
      '</main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.messages.map((message) => ({ sender: message.sender, containsToken: message.text.includes(token) })))
      .toEqual([
        { sender: 'you', containsToken: true },
        { sender: 'other', containsToken: true },
        { sender: 'you', containsToken: false }
      ]);
    // Presence in extracted text is not provider acknowledgement or delivery confirmation.
  });

  it('keeps the newest reply token inside the timestamp-proven window on threads longer than the message cap', async () => {
    const base = Date.UTC(2026, 8, 14, 10, 0, 0);
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      Array.from({ length: MESSENGER_EXTRACT_LIMITS.maxMessages }, (_, index) =>
        `<div role="row" aria-label="You said: synthetic">Earlier synthetic message<time datetime="${new Date(base + index * 1000).toISOString()}"></time></div>`).join('') +
      `<div role="row" aria-label="You said: synthetic">Newest [synthetic-reply-token]<time datetime="${new Date(base + 60_000).toISOString()}"></time></div></main>`);
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    // A head-anchored window once excluded this newest token, pinning a successful send's
    // reconciliation at 'unknown' forever. The timestamp-proven window must contain the tail.
    expect(window.kind).toBe('window');
    if (window.kind !== 'window') throw new Error('expected a proven window');
    expect(window.messages).toHaveLength(MESSENGER_EXTRACT_LIMITS.maxMessages);
    expect(window.messages[window.messages.length - 1]?.text).toContain('[synthetic-reply-token]');
    // Older messages fell out of the bounded window, and the read says so.
    expect(window.truncated).toBe(true);
  });

  it('fails closed when the page renders more rows than the scan bound', async () => {
    const base = Date.UTC(2026, 8, 14, 10, 0, 0);
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      Array.from({ length: MESSENGER_EXTRACT_LIMITS.maxMessagesScan + 40 }, (_, index) =>
        `<div role="row" aria-label="You said: synthetic">Earlier synthetic message<time datetime="${new Date(base + index * 1000).toISOString()}"></time></div>`).join('') +
      '<div role="row" aria-label="You said: synthetic">Newest [synthetic-reply-token]</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // A row beyond the bound was never examined, so it could carry the newest timestamp: the
    // newest end of the thread is not proven and the read fails closed instead of guessing.
    expect(extracted.diagnostics?.scanBoundExceeded).toBe(true);
    expect(extracted.diagnostics?.scannedRows).toBe(MESSENGER_EXTRACT_LIMITS.maxMessagesScan);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'scan_bound_exceeded' });
  });

  it('proves the window from explicit timestamps on a virtualized DOM without claiming more coverage than it shows', async () => {
    const base = Date.UTC(2026, 8, 14, 10, 0, 0);
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      Array.from({ length: 24 }, (_, index) =>
        `<div role="row" aria-label="Synthetic Seller said: synthetic">Rendered earlier reply<time datetime="${new Date(base + index * 1000).toISOString()}"></time></div>`).join('') +
      `<div role="row" aria-label="You said: synthetic">Newest [synthetic-reply-token]<time datetime="${new Date(base + 24_000).toISOString()}"></time></div></main>`);
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.diagnostics?.scannedRows).toBe(25);
    expect(extracted.diagnostics?.truncated).toBe(false);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window.kind).toBe('window');
    if (window.kind !== 'window') throw new Error('expected a proven window');
    expect(window.messages[window.messages.length - 1]?.text).toContain('[synthetic-reply-token]');
    expect(window.truncated).toBe(false);
  });
});

// Non-browser unit test: verifies the pure composer decision contract (count ->
// present/absent/ambiguous) that the real sendThread applies on the Node side after the
// thin in-page count. No page or browser APIs are involved, so this runs locally without
// Chromium.
describe('classifyMessengerComposerCount (pure composer decision contract)', () => {
  it('reports absent when there are no contract composers', () => {
    expect(classifyMessengerComposerCount(0)).toBe('absent');
  });

  it('reports present when there is exactly one contract composer', () => {
    expect(classifyMessengerComposerCount(1)).toBe('present');
  });

  it('reports ambiguous when there are two or more contract composers (unsafe to target)', () => {
    expect(classifyMessengerComposerCount(2)).toBe('ambiguous');
    expect(classifyMessengerComposerCount(3)).toBe('ambiguous');
    expect(classifyMessengerComposerCount(10)).toBe('ambiguous');
  });

  it('treats a non-positive count as absent (defensive)', () => {
    expect(classifyMessengerComposerCount(-1)).toBe('absent');
  });

  it('is deterministic across repeated calls for the same count', () => {
    for (let count = 0; count <= 4; count++) {
      expect(classifyMessengerComposerCount(count)).toBe(classifyMessengerComposerCount(count));
    }
  });
});

// Non-browser unit test: the pure window orientation contract. The newest end of a thread read
// window is established only by the explicit timestamps carried on the message rows, so the
// decision is applied on the Node side and runs locally without Chromium.
describe('selectMessengerThreadWindow (pure window orientation contract)', () => {
  const diagnostics = (overrides: Partial<NonNullable<ExtractedThreadPage['diagnostics']>> = {}) => ({
    hasMessageLog: true,
    hasArticleMessages: false,
    hasExplicitEmptyState: false,
    scannedRows: 2,
    unattributedRows: 0,
    undatedMessages: 0,
    scanBoundExceeded: false,
    truncated: false,
    ...overrides
  });

  const candidate = (text: string, sentAt?: string) => ({
    sender: 'you' as const,
    text,
    ...(sentAt ? { sentAt } : {})
  });

  it('selects the newest candidates by explicit timestamp and returns them oldest-first', () => {
    const outcome = selectMessengerThreadWindow({
      candidates: [
        candidate('Older', '2026-09-14T10:00:00.000Z'),
        candidate('Newest', '2026-09-14T12:00:00.000Z'),
        candidate('Middle', '2026-09-14T11:00:00.000Z')
      ],
      diagnostics: diagnostics(),
      maxMessages: 50
    });
    expect(outcome).toEqual({
      kind: 'window',
      messages: [
        { sender: 'you', text: 'Older', sentAt: '2026-09-14T10:00:00.000Z' },
        { sender: 'you', text: 'Middle', sentAt: '2026-09-14T11:00:00.000Z' },
        { sender: 'you', text: 'Newest', sentAt: '2026-09-14T12:00:00.000Z' }
      ],
      truncated: false
    });
  });

  it('returns the same window when the candidates arrive in newest-first DOM order', () => {
    const outcome = selectMessengerThreadWindow({
      candidates: [
        candidate('Newest', '2026-09-14T12:00:00.000Z'),
        candidate('Middle', '2026-09-14T11:00:00.000Z'),
        candidate('Older', '2026-09-14T10:00:00.000Z')
      ],
      diagnostics: diagnostics(),
      maxMessages: 50
    });
    expect(outcome).toEqual({
      kind: 'window',
      messages: [
        { sender: 'you', text: 'Older', sentAt: '2026-09-14T10:00:00.000Z' },
        { sender: 'you', text: 'Middle', sentAt: '2026-09-14T11:00:00.000Z' },
        { sender: 'you', text: 'Newest', sentAt: '2026-09-14T12:00:00.000Z' }
      ],
      truncated: false
    });
  });

  it('fails closed when a candidate carries no explicit timestamp', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z'), candidate('Undated')],
      diagnostics: diagnostics(),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'undated_messages' });
  });

  it('keeps the newest messages and reports truncation when there are more candidates than the window', () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      candidate(`Message ${index}`, new Date(Date.UTC(2026, 8, 14, 10, 0, index)).toISOString()));
    const outcome = selectMessengerThreadWindow({ candidates, diagnostics: diagnostics(), maxMessages: 2 });
    expect(outcome).toEqual({
      kind: 'window',
      messages: [
        { sender: 'you', text: 'Message 2', sentAt: '2026-09-14T10:00:02.000Z' },
        { sender: 'you', text: 'Message 3', sentAt: '2026-09-14T10:00:03.000Z' }
      ],
      truncated: true
    });
  });

  it('fails closed when the extraction reports no diagnostics', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'missing_diagnostics' });
  });

  it('fails closed when the scan bound was exceeded', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ scanBoundExceeded: true, truncated: true }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'scan_bound_exceeded' });
  });
});
