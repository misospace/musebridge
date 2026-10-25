import { readFileSync, existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  extractMessengerInboxPage,
  extractMessengerThreadPage,
  MESSENGER_EXTRACT_LIMITS,
  classifyMessengerComposerCount
} from '../src/facebook-messenger-extract.js';
import { MESSENGER_THREAD_PATH } from '../src/facebook-messenger-url.js';
import { classifyMessengerInboxPage, classifyMessengerThreadPage } from '../src/facebook-messenger-parse.js';

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
      { sender: 'you', text: 'Is the desk available?' },
      { sender: 'other', senderName: 'Synthetic Seller', text: 'Yes, it is available.10:30', sentAt: '2026-09-14T10:30:00.000Z' },
      { sender: 'other', senderName: 'Example Buyer', text: 'Could I pick it up tomorrow?' }
    ]);
    expect(classifyMessengerThreadPage(extracted)).toBe('messages');
  });

  it('caps thread and message extraction to configured bounds', async () => {
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
      Array.from({ length: 8 }, (_, index) => `<div role="row" aria-label="Synthetic Seller said: ${index}">Message ${index}</div>`).join('') + '</main></body></html>';
    await page.setContent(threadHtml, { waitUntil: 'domcontentloaded' });
    const messages = await page.evaluate(extractMessengerThreadPage, {
      limits: { ...MESSENGER_EXTRACT_LIMITS, maxMessages: 3, maxMessagesScan: 5, maxTextLength: 9 }
    });
    // The window is tail-anchored: the newest rows are always inside it, and the bound keeps the
    // newest maxMessages attributed rows in chronological order, never the oldest.
    expect(messages.messages.map((message) => message.text)).toEqual(['Message 5', 'Message 6', 'Message 7']);
    expect(messages.diagnostics?.truncated).toBe(true);
  });

  it('does not attribute the observed article layout or its token-bearing content', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/thread-articles-unattributed.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.signals.hasMainLandmark).toBe(true);
    expect(extracted.signals.hasAuthenticatedMarker).toBe(true);
    expect(extracted.messages).toEqual([]);
    expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
    expect(extracted.diagnostics).toEqual({
      hasMessageLog: true, hasArticleMessages: true, hasExplicitEmptyState: false,
      scannedRows: 1, unattributedRows: 1, truncated: false
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

  it('keeps the newest reply token inside the tail window on threads longer than the message cap', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      Array.from({ length: MESSENGER_EXTRACT_LIMITS.maxMessages }, () => '<div role="row" aria-label="You said: synthetic">Earlier synthetic message</div>').join('') +
      '<div role="row" aria-label="You said: synthetic">Newest [synthetic-reply-token]</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // A head-anchored window once excluded this newest token, pinning a successful send's
    // reconciliation at 'unknown' forever. The window must contain the tail instead.
    expect(extracted.messages).toHaveLength(MESSENGER_EXTRACT_LIMITS.maxMessages);
    expect(extracted.messages[extracted.messages.length - 1]?.text).toContain('[synthetic-reply-token]');
    // Older messages fell out of the bounded window, and the read says so.
    expect(extracted.diagnostics?.truncated).toBe(true);
  });

  it('keeps the newest reply token inside the tail window past the scan cap', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      Array.from({ length: MESSENGER_EXTRACT_LIMITS.maxMessagesScan + 40 }, () => '<div role="row" aria-label="You said: synthetic">Earlier synthetic message</div>').join('') +
      '<div role="row" aria-label="You said: synthetic">Newest [synthetic-reply-token]</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The scan cap cannot hide the tail either: rows are examined newest-first, independent of
    // thread length, so the token is inside the window on a 161-row thread as on a 2-row thread.
    expect(extracted.messages.some((message) => message.text.includes('[synthetic-reply-token]'))).toBe(true);
    expect(extracted.diagnostics?.scannedRows).toBeLessThanOrEqual(MESSENGER_EXTRACT_LIMITS.maxMessagesScan);
    expect(extracted.diagnostics?.truncated).toBe(true);
  });

  it('reports a virtualized tail-only DOM as an untruncated window that contains the newest token', async () => {
    // A virtualized message log renders only the newest rows; every row present in the DOM is
    // inside the examined window, so coverage reports truncation false while the newest token —
    // the reconciliation target — is visible. Coverage describes the DOM window, not the
    // provider's total history, and no unvalidated deployed-DOM behavior is assumed here.
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      Array.from({ length: 24 }, () => '<div role="row" aria-label="Synthetic Seller said: synthetic">Rendered earlier reply</div>').join('') +
      '<div role="row" aria-label="You said: synthetic">Newest [synthetic-reply-token]</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.messages[extracted.messages.length - 1]?.text).toContain('[synthetic-reply-token]');
    expect(extracted.diagnostics?.truncated).toBe(false);
    expect(extracted.diagnostics?.scannedRows).toBe(25);
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
