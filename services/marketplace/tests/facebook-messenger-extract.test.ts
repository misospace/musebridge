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
import { classifyMessengerInboxPage, classifyMessengerThreadPage, interpretMessengerThreadPage } from '../src/facebook-messenger-parse.js';
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
    // Every candidate anchor fit inside the scan bound, so the extracted threads are not
    // suspected of leaving rows unread.
    expect(extracted.threadsScanSaturated).toBe(false);
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
it('gates inbox captcha on visible evidence and downgrades a dormant widget (#168)', async () => {
  const dormantHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-captcha-dormant.html', import.meta.url), 'utf8');
  await page.setContent(dormantHtml, { waitUntil: 'domcontentloaded' });
  const dormant = await page.evaluate(extractMessengerInboxPage, {
    threadPath: MESSENGER_THREAD_PATH,
    limits: MESSENGER_EXTRACT_LIMITS
  });
  // The hidden widget still matches the raw structural signal, but it is not visible evidence.
  expect(dormant.signals.hasCaptchaFrame).toBe(true);
  expect(dormant.signals.captchaVisible).toBe(false);
  expect(classifyMessengerInboxPage(dormant)).toBe('unknown');
  const visibleHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-captcha-visible.html', import.meta.url), 'utf8');
  await page.setContent(visibleHtml, { waitUntil: 'domcontentloaded' });
  const visible = await page.evaluate(extractMessengerInboxPage, {
    threadPath: MESSENGER_THREAD_PATH,
    limits: MESSENGER_EXTRACT_LIMITS
  });
  // A rendered captcha widget keeps the challenge classification.
  expect(visible.signals.hasCaptchaFrame).toBe(true);
  expect(visible.signals.captchaVisible).toBe(true);
  expect(classifyMessengerInboxPage(visible)).toBe('captcha');
});

  it('recognizes a challenge phrase split across inline elements on inbox and thread pages (#168)', async () => {
    const inboxHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-captcha-phrase-split.html', import.meta.url), 'utf8');
    await page.setContent(inboxHtml, { waitUntil: 'domcontentloaded' });
    const inbox = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    // The phrase is matched over the rendered text, so a challenge split across inline elements is
    // visible evidence: the page is a challenge, not a downgraded unknown.
    expect(inbox.signals.mentionsCaptcha).toBe(true);
    expect(inbox.signals.captchaVisible).toBe(true);
    expect(classifyMessengerInboxPage(inbox)).toBe('captcha');

    const threadHtml = readFileSync(new URL('./fixtures/facebook-messenger/thread-captcha-phrase-split.html', import.meta.url), 'utf8');
    await page.setContent(threadHtml, { waitUntil: 'domcontentloaded' });
    const thread = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(thread.signals.mentionsCaptcha).toBe(true);
    expect(thread.signals.captchaVisible).toBe(true);
    expect(classifyMessengerThreadPage(thread)).toBe('captcha');
  });

  it('keeps the raw captcha signal aligned with the visibility gate when a phrase breaks across lines (#168)', async () => {
    const inboxHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-captcha-phrase-newline.html', import.meta.url), 'utf8');
    await page.setContent(inboxHtml, { waitUntil: 'domcontentloaded' });
    const inbox = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    // The rendered-text gate reads the line-broken phrase as a visible challenge, so the raw
    // signal must match it too; otherwise the classifier never enters the captcha branch and a
    // genuinely rendered challenge stays unknown instead of hard-opening the breaker.
    expect(inbox.signals.mentionsCaptcha).toBe(true);
    expect(inbox.signals.captchaVisible).toBe(true);
    expect(classifyMessengerInboxPage(inbox)).toBe('captcha');

    const threadHtml = readFileSync(new URL('./fixtures/facebook-messenger/thread-captcha-phrase-newline.html', import.meta.url), 'utf8');
    await page.setContent(threadHtml, { waitUntil: 'domcontentloaded' });
    const thread = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(thread.signals.mentionsCaptcha).toBe(true);
    expect(thread.signals.captchaVisible).toBe(true);
    expect(classifyMessengerThreadPage(thread)).toBe('captcha');
  });

  it('keeps a split challenge phrase dormant while it is not rendered (#168)', async () => {
    const dormantHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-captcha-phrase-split-dormant.html', import.meta.url), 'utf8');
    await page.setContent(dormantHtml, { waitUntil: 'domcontentloaded' });
    const dormant = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    // The words still match the raw signal, but a transparent challenge is not a visible one, so
    // the page stays the probe's `ambiguous` instead of asserting a challenge.
    expect(dormant.signals.mentionsCaptcha).toBe(true);
    expect(dormant.signals.captchaVisible).toBe(false);
    expect(classifyMessengerInboxPage(dormant)).toBe('unknown');
  });

  it('records scan saturation when candidate anchors remain beyond the thread scan bound', async () => {
    const saturatedHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<a href="/messages/t/1684432532/">Visible thread</a>' +
      Array.from({ length: MESSENGER_EXTRACT_LIMITS.maxThreadsScan + 5 }, (_, index) => `<a href="/about/${index}/">Filler</a>`).join('') +
      '<a href="/messages/t/1684432599/">Beyond the scan bound</a></main></body></html>';
    await page.setContent(saturatedHtml, { waitUntil: 'domcontentloaded' });
    const saturated = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    // The scan examined only its bound of anchors, so the thread anchor rendered beyond it was
    // never read: the page must record that its extracted threads are not proven to be the
    // whole inbox.
    expect(saturated.threadsScanSaturated).toBe(true);
    expect(saturated.threads.map((thread) => thread.threadId)).toEqual(['1684432532']);
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
      messageLikeBlocks: 0,
      // The page has no message log, so the rows are collected from the one container that holds
      // the declared message set, and every rendered row is inside that scope.
      rowScope: 'page_container',
      roleRowsOutsideScope: 0,
      renderedRows: 6,
      scannedRows: 6,
      unattributedRows: 1,
      undatedMessages: 0, candidateTextBudgetExceeded: false,
      // The page declared a set of six items and rendered exactly those six rows, so the
      // rendered rows are the whole message set and their positions agree with that count.
      declaredSetSize: 6,
      setSizeConflict: false,
      attestedRows: 6,
      positionedRows: 6,
      newestPosition: 6,
      distinctPositions: 6
    });
    expect(classifyMessengerThreadPage(extracted)).toBe('messages');
    // A live conversation carries no unavailable notice, and the marker stays out of its report.
    expect(extracted.hasUnavailableMarker).toBe(false);
  });

  it('recognizes explicit unavailable and nonexistent notices on synthetic thread pages', async () => {
    const unavailableHtml = readFileSync(new URL('./fixtures/facebook-messenger/thread-unavailable.html', import.meta.url), 'utf8');
    await page.setContent(unavailableHtml, { waitUntil: 'domcontentloaded' });
    const unavailable = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(unavailable.hasUnavailableMarker).toBe(true);
    expect(unavailable.messages).toEqual([]);
    expect(unavailable.diagnostics?.hasMessageLog).toBe(false);
    // The recognized notice state renders no message-like structure at all, so the absence
    // proof's article/labelled-block counter is zero on both fixture pages.
    expect(unavailable.diagnostics?.messageLikeBlocks).toBe(0);
    expect(classifyMessengerThreadPage(unavailable)).toBe('unavailable');

    const nonexistentHtml = readFileSync(new URL('./fixtures/facebook-messenger/thread-nonexistent.html', import.meta.url), 'utf8');
    await page.setContent(nonexistentHtml, { waitUntil: 'domcontentloaded' });
    const nonexistent = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
  expect(nonexistent.hasUnavailableMarker).toBe(true);
  expect(nonexistent.diagnostics?.messageLikeBlocks).toBe(0);
  expect(classifyMessengerThreadPage(nonexistent)).toBe('unavailable');
});
it('downgrades a dormant captcha widget on a thread page instead of asserting a challenge (#168)', async () => {
  const html = readFileSync(new URL('./fixtures/facebook-messenger/thread-captcha-dormant.html', import.meta.url), 'utf8');
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
  // The hidden widget still matches the raw structural signal, but it is not visible evidence:
  // the page is neither a challenge nor a trusted thread layout.
  expect(extracted.signals.hasCaptchaFrame).toBe(true);
  expect(extracted.signals.captchaVisible).toBe(false);
  expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
});

  it('never selects the unavailable state over a rendered conversation or a contradicting message log', async () => {
    // Seller text quoting the notice inside a live conversation must not turn it into a NOT_FOUND.
    const conversationHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<div role="row" aria-setsize="1" aria-label="Synthetic Seller said: re-sending the notice">' +
      'This content isn\'t available right now, here is the direct link<time datetime="2026-09-14T10:30:00Z"></time></div>' +
      '</main></body></html>';
    await page.setContent(conversationHtml, { waitUntil: 'domcontentloaded' });
    const conversation = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(conversation.hasUnavailableMarker).toBe(true);
    expect(classifyMessengerThreadPage(conversation)).toBe('messages');

    // A page that renders a message log beside the notice contradicts itself: unrecognized, never absence.
    const contradictingHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<div role="log" aria-label="Synthetic messages">This content isn\'t available right now</div>' +
      '</main></body></html>';
    await page.setContent(contradictingHtml, { waitUntil: 'domcontentloaded' });
    const contradicting = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(contradicting.hasUnavailableMarker).toBe(true);
    expect(contradicting.diagnostics?.hasMessageLog).toBe(true);
    expect(classifyMessengerThreadPage(contradicting)).toBe('unknown');

    // A no-log row with an unrecognized sender label quoting the notice is still row structure
    // the notice cannot disprove: the report shows a rendered, unattributed row, so the layout
    // is ambiguous and never verifies absence.
    const noLogRowHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<div role="row" aria-label="Some unrecognized label">This content isn\'t available right now</div>' +
      '</main></body></html>';
    await page.setContent(noLogRowHtml, { waitUntil: 'domcontentloaded' });
    const noLogRow = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(noLogRow.hasUnavailableMarker).toBe(true);
    expect(noLogRow.messages).toEqual([]);
    expect(noLogRow.diagnostics?.hasMessageLog).toBe(false);
    expect(noLogRow.diagnostics?.renderedRows).toBe(1);
    expect(noLogRow.diagnostics?.unattributedRows).toBe(1);
    expect(classifyMessengerThreadPage(noLogRow)).toBe('unknown');

    // A no-log `article` quoting the notice is message-like structure the row counters cannot
    // see (#166): an article is the accessibility element of a single message, so the notice
    // cannot disprove the block the page rendered, and the layout stays ambiguous.
    const articleNoticeHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<article>This content isn\'t available right now</article>' +
      '</main></body></html>';
    await page.setContent(articleNoticeHtml, { waitUntil: 'domcontentloaded' });
    const articleNotice = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(articleNotice.hasUnavailableMarker).toBe(true);
    expect(articleNotice.messages).toEqual([]);
    expect(articleNotice.diagnostics?.hasMessageLog).toBe(false);
    expect(articleNotice.diagnostics?.renderedRows).toBe(0);
    expect(articleNotice.diagnostics?.roleRowsOutsideScope).toBe(0);
    expect(articleNotice.diagnostics?.messageLikeBlocks).toBe(1);
    expect(classifyMessengerThreadPage(articleNotice)).toBe('unknown');

    // The same holds when the message-like block is declared by its role instead of its tag.
    const articleRoleNoticeHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<div role="article">This content isn\'t available right now</div>' +
      '</main></body></html>';
    await page.setContent(articleRoleNoticeHtml, { waitUntil: 'domcontentloaded' });
    const articleRoleNotice = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(articleRoleNotice.hasUnavailableMarker).toBe(true);
    expect(articleRoleNotice.diagnostics?.messageLikeBlocks).toBe(1);
    expect(classifyMessengerThreadPage(articleRoleNotice)).toBe('unknown');

    // Repeated plain message-like blocks that carry the message row's attribution grammar in
    // their `aria-label` — everything but the `role="row"` attribute — are message structure the
    // notice cannot disprove either, so the layout never verifies absence. The notice wording is
    // rendered text here, so the page really is a candidate for verified absence and the
    // message-like counter is what keeps it out of that state.
    const labelledBlocksHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<div aria-label="Synthetic Seller said: This content isn\'t available right now">This content isn\'t available right now</div>' +
      '<div aria-label="Synthetic Buyer said: This conversation isn\'t available right now">This conversation isn\'t available right now</div>' +
      '</main></body></html>';
    await page.setContent(labelledBlocksHtml, { waitUntil: 'domcontentloaded' });
    const labelledBlocks = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(labelledBlocks.hasUnavailableMarker).toBe(true);
    expect(labelledBlocks.messages).toEqual([]);
    expect(labelledBlocks.diagnostics?.hasMessageLog).toBe(false);
    expect(labelledBlocks.diagnostics?.renderedRows).toBe(0);
    expect(labelledBlocks.diagnostics?.roleRowsOutsideScope).toBe(0);
    expect(labelledBlocks.diagnostics?.messageLikeBlocks).toBe(2);
    expect(classifyMessengerThreadPage(labelledBlocks)).toBe('unknown');

    // The same wording that exists only in an accessible name is not a notice the page renders,
    // so it never reaches the absence proof: the page stays unrecognized and typed. Reading the
    // notice out of attributes would widen the set of pages that can verify absence, so this
    // boundary stays pinned.
    const labelOnlyNoticeHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      '<div aria-label="This content isn\'t available right now">Read it here</div>' +
      '</main></body></html>';
    await page.setContent(labelOnlyNoticeHtml, { waitUntil: 'domcontentloaded' });
    const labelOnlyNotice = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(labelOnlyNotice.hasUnavailableMarker).toBe(false);
    // Nothing else blocks this page: the missing marker is the only reason it stays unknown, so
    // a marker read out of attributes would turn it into a verified absence.
    expect(labelOnlyNotice.diagnostics?.renderedRows).toBe(0);
    expect(labelOnlyNotice.diagnostics?.messageLikeBlocks).toBe(0);
    expect(classifyMessengerThreadPage(labelOnlyNotice)).toBe('unknown');
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
      Array.from({ length: 8 }, (_, index) => `<div role="row" aria-setsize="8" aria-label="Synthetic Seller said: ${index}">Message ${index}<time datetime="2026-09-14T10:0${index}:00Z"></time></div>`).join('') + '</main></body></html>';
    await page.setContent(threadHtml, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // Every rendered row is examined and every attributed row is a candidate: the probe collects
    // evidence, it does not choose the window, so no DOM-order assumption can leak into it.
    expect(extracted.messages).toHaveLength(8);
    expect(extracted.diagnostics?.scannedRows).toBe(8);
    expect(extracted.diagnostics?.renderedRows).toBe(8);
    expect(extracted.diagnostics?.undatedMessages).toBe(0);
    // The page declared the size of its message set, so the eight rendered rows are provably
    // the whole set and the window can be certified.
    expect(extracted.diagnostics?.declaredSetSize).toBe(8);
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
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span><div role="log" aria-setsize="2">' +
      '<div role="row" aria-setsize="2" aria-label="Synthetic Seller said: newest">Newest reply<time datetime="2026-09-14T12:00:00Z"></time></div>' +
      '<div role="row" aria-setsize="2" aria-label="Synthetic Seller said: oldest">Oldest reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The probe reports the candidates in DOM order; it never decides which end is newest.
    expect(extracted.messages.map((message) => message.text)).toEqual(['Newest reply', 'Oldest reply']);
    // The message log declares the size of its set and each row attests that it belongs to it,
    // so the two rendered rows are the whole set.
    expect(extracted.diagnostics?.declaredSetSize).toBe(2);
    expect(extracted.diagnostics?.renderedRows).toBe(2);
    expect(extracted.diagnostics?.attestedRows).toBe(2);
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
    expect(extracted.diagnostics?.renderedRows).toBe(1);
  });

  it('reads a row timestamp only from the row own time element', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="Synthetic Seller said: direct">Direct marker<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-label="Synthetic Seller said: nested">Nested marker<span><time datetime="2026-09-14T11:00:00Z"></time></span></div>' +
      '</main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The row own marker is the only evidence of where the row sits in the timeline; a nested
    // element timestamp describes something else, so that row stays undated.
    expect(extracted.messages.map((message) => ({ text: message.text, sentAt: message.sentAt }))).toEqual([
      { text: 'Direct marker', sentAt: '2026-09-14T10:00:00.000Z' },
      { text: 'Nested marker', sentAt: undefined }
    ]);
    expect(extracted.diagnostics?.undatedMessages).toBe(1);
    expect(extracted.diagnostics?.scannedRows).toBe(2);
    expect(extracted.diagnostics?.renderedRows).toBe(2);
  });

  it('counts an attributed row without any timestamp of its own as undated, with or without text', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="You said: synthetic">Undated text</div>' +
      '<div role="row" aria-label="You sent an attachment"></div>' +
      '</main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // Every attributed row must carry its own usable timestamp, so both rows break the proof:
    // the attachment-only row carries no text, but it is still an attributed row on the timeline.
    expect(extracted.diagnostics?.undatedMessages).toBe(2);
    expect(extracted.messages.map((message) => message.text)).toEqual(['Undated text']);
    expect(extracted.messages[0]?.sentAt).toBeUndefined();
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'undated_messages' });
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
      // The article layout's two `role="article"` nodes are message-like structure, so the
      // report counts them; the absence predicate can never reach this page anyway, because it
      // renders a message log.
      messageLikeBlocks: 2,
      // The message log renders no rows, so it is still the scope of the conversation: the row
      // the page rendered outside it is counted, never collected.
      rowScope: 'message_log',
      roleRowsOutsideScope: 1,
      renderedRows: 0, scannedRows: 0, unattributedRows: 0, undatedMessages: 0, candidateTextBudgetExceeded: false,
      // The scope declares no size for a message set, so the read never certifies a window.
      declaredSetSize: undefined,
      setSizeConflict: false,
      attestedRows: 0,
      positionedRows: 0,
      newestPosition: undefined,
      distinctPositions: 0
    });
  });

  it('keeps empty and attachment-only thread layouts unknown without verified contracts', async () => {
    for (const [content, renderedRows] of [
      ['<div role="log">No messages yet</div>', 0],
      ['<div role="row" aria-label="You sent an attachment"></div>', 1],
      ['<div role="row" aria-label="You sent an attachment"><time datetime="2026-09-14T10:34:00Z"></time></div>', 1]
    ] as const) {
      await page.setContent(`<main><span aria-label="Your account">Synthetic account</span>${content}</main>`);
      const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
      // An attachment-only row is not a message candidate, dated or not: the layout stays
      // unverified, and an undated attributed row also breaks the timestamp proof.
      expect(extracted.messages).toEqual([]);
      expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
      expect(extracted.diagnostics?.renderedRows).toBe(renderedRows);
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
        `<div role="row" aria-setsize="${MESSENGER_EXTRACT_LIMITS.maxMessages + 1}" aria-label="You said: synthetic">Earlier synthetic message<time datetime="${new Date(base + index * 1000).toISOString()}"></time></div>`).join('') +
      `<div role="row" aria-setsize="${MESSENGER_EXTRACT_LIMITS.maxMessages + 1}" aria-label="You said: synthetic">Newest [synthetic-reply-token]<time datetime="${new Date(base + 60_000).toISOString()}"></time></div></main>`);
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
    expect(extracted.diagnostics?.scannedRows).toBe(MESSENGER_EXTRACT_LIMITS.maxMessagesScan);
    expect(extracted.diagnostics?.renderedRows).toBe(MESSENGER_EXTRACT_LIMITS.maxMessagesScan + 41);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_scan' });
  });

  it('fails closed when the collected candidate text exceeds its budget', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="You said: synthetic">Alpha<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-label="You said: synthetic">Bravo<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '<div role="row" aria-label="You said: synthetic">Charlie<time datetime="2026-09-14T10:02:00Z"></time></div>' +
      '<div role="row" aria-label="You said: synthetic">Delta<time datetime="2026-09-14T10:03:00Z"></time></div>' +
      '</main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, {
      limits: { ...MESSENGER_EXTRACT_LIMITS, maxCandidateTextLength: 10 }
    });
    // The total candidate text is bounded, so the scan stops early and the rows it did not
    // examine could carry the newest timestamp: the window proof fails closed.
    expect(extracted.diagnostics?.scannedRows).toBe(3);
    expect(extracted.diagnostics?.renderedRows).toBe(4);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_scan' });
  });

  it('fails closed when the candidate text budget is spent on the last rendered row', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="You said: synthetic">Alpha<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-label="You said: synthetic">Bravo<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, {
      limits: { ...MESSENGER_EXTRACT_LIMITS, maxCandidateTextLength: 6 }
    });
    // Every rendered row was examined here, so the rows alone would prove the window. The read is
    // still over its text budget, and a window collected over budget is not a bounded window, so
    // the proof fails closed rather than returning one.
    expect(extracted.diagnostics?.scannedRows).toBe(2);
    expect(extracted.diagnostics?.renderedRows).toBe(2);
    expect(extracted.diagnostics?.candidateTextBudgetExceeded).toBe(true);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_scan' });
  });

  it('proves the window from explicit timestamps on a virtualized DOM without claiming more coverage than it shows', async () => {
    const base = Date.UTC(2026, 8, 14, 10, 0, 0);
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      Array.from({ length: 24 }, (_, index) =>
        `<div role="row" aria-setsize="25" aria-label="Synthetic Seller said: synthetic">Rendered earlier reply<time datetime="${new Date(base + index * 1000).toISOString()}"></time></div>`).join('') +
      `<div role="row" aria-setsize="25" aria-label="You said: synthetic">Newest [synthetic-reply-token]<time datetime="${new Date(base + 24_000).toISOString()}"></time></div></main>`);
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.diagnostics?.scannedRows).toBe(25);
    expect(extracted.diagnostics?.renderedRows).toBe(25);
    // The page declared the size of its message set, so the rendered rows are provably the
    // whole set: the window is certified without claiming more coverage than the page shows.
    expect(extracted.diagnostics?.declaredSetSize).toBe(25);
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

  it('fails closed when the page renders only a window of the message set it declares', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/thread-virtualized-subset.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The layout is recognized and every rendered row was examined, but the page declares a
    // set of 120 messages and renders three of them: the newest message was never rendered,
    // so the rendered rows can never be certified as the thread's tail.
    expect(classifyMessengerThreadPage(extracted)).toBe('messages');
    expect(extracted.diagnostics?.renderedRows).toBe(3);
    expect(extracted.diagnostics?.scannedRows).toBe(3);
    expect(extracted.diagnostics?.declaredSetSize).toBe(120);
    expect(extracted.diagnostics?.positionedRows).toBe(3);
    expect(extracted.diagnostics?.distinctPositions).toBe(3);
    expect(extracted.diagnostics?.newestPosition).toBe(102);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('fails closed when the rendered window is the oldest part of the declared message set', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/thread-virtualized-oldest.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The rendered rows are the first three of a declared set of 120, so the newest declared
    // position stops far before the end of the set and the newest message is not among them.
    expect(extracted.diagnostics?.renderedRows).toBe(3);
    expect(extracted.diagnostics?.declaredSetSize).toBe(120);
    expect(extracted.diagnostics?.positionedRows).toBe(3);
    expect(extracted.diagnostics?.distinctPositions).toBe(3);
    expect(extracted.diagnostics?.newestPosition).toBe(3);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('fails closed when the declared positions stop before the end of the declared set', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-setsize="3" aria-posinset="1" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-setsize="3" aria-posinset="2" aria-label="You said: second">Second reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '<div role="row" aria-setsize="3" aria-label="Synthetic Seller said: third">Third reply<time datetime="2026-09-14T10:02:00Z"></time></div>' +
      '</main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The rendered rows match the declared set size, but the rows that declare a position stop
    // at the second one, so the declared accounting does not cover the whole set.
    expect(extracted.diagnostics?.renderedRows).toBe(3);
    expect(extracted.diagnostics?.declaredSetSize).toBe(3);
    expect(extracted.diagnostics?.positionedRows).toBe(2);
    expect(extracted.diagnostics?.distinctPositions).toBe(2);
    expect(extracted.diagnostics?.newestPosition).toBe(2);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('treats the ARIA unknown-size marker as no declared set size', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="log" aria-setsize="-1">' +
      '<div role="row" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // `-1` is the ARIA "unknown size" marker, so the page declares no size at all and the one
    // rendered row cannot be told apart from a window of a longer thread.
    expect(extracted.diagnostics?.renderedRows).toBe(1);
    expect(extracted.diagnostics?.declaredSetSize).toBeUndefined();
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'missing_set_accounting' });
  });

  it('fails closed when the scope holds rows of another set beside the message rows', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="log" aria-setsize="5">' +
      '<div role="row" aria-setsize="5" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-setsize="5" aria-label="You said: second">Second reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '<div role="row" aria-setsize="5" aria-label="Synthetic Seller said: third">Third reply<time datetime="2026-09-14T10:02:00Z"></time></div>' +
      '<div role="grid">' +
      '<div role="row">Unrelated navigation row</div><div role="row">Unrelated navigation row</div>' +
      '</div></div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The scope renders five rows and declares a set of five, but only the three message rows
    // attest that they belong to that set: the other two rows belong to a nested set, so the
    // count alone must not certify the rendered rows as the whole message set.
    expect(extracted.diagnostics?.renderedRows).toBe(5);
    expect(extracted.diagnostics?.declaredSetSize).toBe(5);
    expect(extracted.diagnostics?.attestedRows).toBe(3);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('certifies a set whose container counts it with aria-rowcount and positions its rows', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="grid" aria-rowcount="2">' +
      '<div role="row" aria-posinset="1" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-posinset="2" aria-label="You said: second">Second reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // `aria-rowcount` is the container counter for a row set, and every row declares its own
    // position in that set, so the two rendered rows are provably the whole set.
    expect(extracted.diagnostics?.declaredSetSize).toBe(2);
    expect(extracted.diagnostics?.attestedRows).toBe(2);
    expect(extracted.diagnostics?.newestPosition).toBe(2);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window.kind).toBe('window');
    expect(window.kind === 'window' ? window.truncated : null).toBe(false);
  });

  it('fails closed when the container and the rows declare different set sizes', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="log" aria-setsize="3">' +
      '<div role="row" aria-setsize="4" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-setsize="4" aria-label="You said: second">Second reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</div></main>');
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The container and the rows describe different sets, so the scope holds more than one set
    // and nothing in it can be certified as the whole message set.
    expect(extracted.diagnostics?.setSizeConflict).toBe(true);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('collects every rendered row from the one container that holds them and certifies no window', async () => {
    // The page has no message log, so the scope is the one container that holds every rendered
    // row: the rows the page rendered beside the conversation are part of that scope.
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<section>' +
      '<div role="row" aria-setsize="2" aria-posinset="1" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-setsize="2" aria-posinset="2" aria-label="You said: second">Second reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</section>' +
      '<div>' +
      '<div role="row">Unrelated widget row</div>' +
      '<div role="row" aria-label="Someone Else said: not a message">Not a message<time datetime="2026-09-14T11:00:00Z"></time></div>' +
      '</div></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.diagnostics?.rowScope).toBe('page_container');
    expect(extracted.diagnostics?.renderedRows).toBe(4);
    // The scope holds every rendered row, so no row lies outside it.
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(0);
    // Only the two conversation rows declare the set, so the page's own accounting does not
    // cover the rows the scope holds and nothing here can be certified as the whole set.
    expect(extracted.diagnostics?.declaredSetSize).toBe(2);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
    expect(interpretMessengerThreadPage({
      page: extracted,
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('fails closed when a widget group declares its own set beside the conversation', async () => {
    // The widget group declares a set of its own, but a set declaration proves only that a row
    // belongs to some set: it never makes that set the message set. The scope is the one
    // container that holds every rendered row, so the widget's rows are collected with the
    // conversation's, and the page's accounting covers two of the three rendered rows: the
    // window fails closed instead of returning the widget's rows as a proven tail.
    await page.setContent('<main role="main"><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="Synthetic Seller said: hello">Hello<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="grid" aria-setsize="2">' +
      '<div role="row" aria-setsize="2" aria-posinset="1" aria-label="Someone Else said: widget one">Widget one<time datetime="2026-09-14T11:00:00Z"></time></div>' +
      '<div role="row" aria-setsize="2" aria-posinset="2" aria-label="Someone Else said: widget two">Widget two<time datetime="2026-09-14T11:01:00Z"></time></div>' +
      '</div></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The scope is the one container that holds every rendered row, the widget group included.
    expect(extracted.diagnostics?.rowScope).toBe('page_container');
    expect(extracted.diagnostics?.renderedRows).toBe(3);
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(0);
    // The declared set covers the two widget rows only, so the scope holds more rows than the
    // page's accounting covers.
    expect(extracted.diagnostics?.declaredSetSize).toBe(2);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
    const outcome = interpretMessengerThreadPage({
      page: extracted,
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    });
    expect(outcome).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
    // The widget rows never reach a returned window.
    expect(outcome).not.toHaveProperty('messages');
    expect(JSON.stringify(outcome)).not.toContain('Widget one');
  });

  it('keeps an attributed row outside the message log out of the collection', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="log" aria-label="Synthetic messages">' +
      '<div role="row" aria-setsize="2" aria-posinset="1" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-setsize="2" aria-posinset="2" aria-label="You said: second">Second reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</div>' +
      '<div>' +
      '<div role="row" aria-label="Someone Else said: not a message">Not a message<time datetime="2026-09-14T11:00:00Z"></time></div>' +
      '</div></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The message log is the scope, so the attributed row the page rendered beside it is not
    // part of the conversation and is not collected.
    expect(extracted.diagnostics?.rowScope).toBe('message_log');
    expect(extracted.diagnostics?.renderedRows).toBe(2);
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(1);
    expect(extracted.messages.map((message) => message.text)).toEqual(['First reply', 'Second reply']);
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window.kind).toBe('window');
  });

  it('fails closed when the rendered rows are spread across the page', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="row" aria-label="Synthetic Seller said: in the main region">Main region reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '</main>' +
      '<footer>' +
      '<div role="row" aria-label="Synthetic Seller said: in the footer">Footer reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</footer>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The rows share no container other than the document itself and they do not share a parent
    // either, so there is no scope to trust and the read collects nothing at all.
    expect(extracted.diagnostics?.rowScope).toBe('ambiguous');
    expect(extracted.diagnostics?.renderedRows).toBe(0);
    expect(extracted.diagnostics?.scannedRows).toBe(0);
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(2);
    expect(extracted.messages).toEqual([]);
    expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
    // An unrecognized layout stays a typed upstream error, never an empty success.
    expect(interpretMessengerThreadPage({
      page: extracted,
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('fails closed when the page renders more than one log with rows', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="log" aria-label="First conversation">' +
      '<div role="row" aria-label="Synthetic Seller said: first">First log reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '</div>' +
      '<div role="log" aria-label="Second conversation">' +
      '<div role="row" aria-label="Synthetic Seller said: second">Second log reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</div></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // Two logs render rows, so neither can be told apart as the conversation: nothing is
    // collected and the read fails closed instead of taking one of them.
    expect(extracted.diagnostics?.rowScope).toBe('ambiguous');
    expect(extracted.diagnostics?.renderedRows).toBe(0);
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(2);
    expect(extracted.messages).toEqual([]);
    expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
    expect(interpretMessengerThreadPage({
      page: extracted,
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('fails closed when a message log is nested inside another message log', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="log" aria-label="Outer conversation">' +
      '<div role="log" aria-label="Inner conversation">' +
      '<div role="row" aria-label="Synthetic Seller said: nested">Nested reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '</div></div></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // Both logs render the row, so neither can be told apart as the conversation: the read
    // collects nothing instead of guessing which log holds it.
    expect(extracted.diagnostics?.rowScope).toBe('ambiguous');
    expect(extracted.diagnostics?.renderedRows).toBe(0);
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(1);
    expect(extracted.messages).toEqual([]);
    expect(interpretMessengerThreadPage({
      page: extracted,
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('does not collect rows outside a message log that renders no rows', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="log" aria-label="Synthetic messages"></div>' +
      '<div>' +
      '<div role="row" aria-label="Someone Else said: not a message">Not a message<time datetime="2026-09-14T11:00:00Z"></time></div>' +
      '</div></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // The message log still names the conversation, so the row the page rendered beside it is
    // not part of it: the scope holds no rows and the read stays unrecognized.
    expect(extracted.diagnostics?.rowScope).toBe('message_log');
    expect(extracted.diagnostics?.renderedRows).toBe(0);
    expect(extracted.diagnostics?.scannedRows).toBe(0);
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(1);
    expect(extracted.messages).toEqual([]);
    expect(classifyMessengerThreadPage(extracted)).toBe('unknown');
    expect(interpretMessengerThreadPage({
      page: extracted,
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('reports no scope at all when the page renders no rows', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<p>Synthetic conversation without any row</p></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // There is no log and no row, so there is no scope to collect from and nothing to report
    // outside it.
    expect(extracted.diagnostics?.rowScope).toBe('none');
    expect(extracted.diagnostics?.renderedRows).toBe(0);
    expect(extracted.diagnostics?.roleRowsOutsideScope).toBe(0);
    expect(extracted.messages).toEqual([]);
  });

  it('does not certify a set from a plain container own aria-setsize', async () => {
    await page.setContent('<main><span aria-label="Your account">Synthetic account</span>' +
      '<div role="list" aria-setsize="2">' +
      '<div role="row" aria-posinset="1" aria-label="Synthetic Seller said: first">First reply<time datetime="2026-09-14T10:00:00Z"></time></div>' +
      '<div role="row" aria-posinset="2" aria-label="You said: second">Second reply<time datetime="2026-09-14T10:01:00Z"></time></div>' +
      '</div></main>', { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    // A plain container is not a set container: only the message log's own counter counts, so
    // the container's own `aria-setsize` certifies nothing and the read has no set accounting.
    // A row's parent `aria-rowcount` remains the standard counter for a grid, table or
    // treegrid, which the case above covers.
    expect(extracted.diagnostics?.rowScope).toBe('page_container');
    expect(extracted.diagnostics?.declaredSetSize).toBeUndefined();
    const window = selectMessengerThreadWindow({
      candidates: extracted.messages,
      diagnostics: extracted.diagnostics,
      maxMessages: MESSENGER_EXTRACT_LIMITS.maxMessages
    });
    expect(window).toEqual({ kind: 'unproven', reason: 'missing_set_accounting' });
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
  // A proven window describes a page that declared the size of its message set, rendered exactly
  // that many rows, and had every rendered row attest that it belongs to that set. The declared
  // size follows the rendered rows unless a case states a different one, and an explicitly absent
  // size states that the page declared none.
  const diagnostics = (overrides: Partial<NonNullable<ExtractedThreadPage['diagnostics']>> = {}) => {
    const renderedRows = overrides.renderedRows ?? 2;
    const declaredSetSize = Object.hasOwn(overrides, 'declaredSetSize') ? overrides.declaredSetSize : renderedRows;
    return {
      hasMessageLog: true,
      hasArticleMessages: false,
      hasExplicitEmptyState: false,
      renderedRows,
      scannedRows: overrides.scannedRows ?? renderedRows,
      unattributedRows: 0,
      undatedMessages: 0, candidateTextBudgetExceeded: false,
      declaredSetSize,
      setSizeConflict: false,
      attestedRows: renderedRows,
      positionedRows: 0,
      distinctPositions: 0,
      ...overrides,
      // The scope the rows were collected from, the rows the page rendered outside it, and the
      // message-like blocks the row counters cannot see belong to the extraction report, so a
      // hand-built report carries them too.
      rowScope: overrides.rowScope ?? 'message_log',
      roleRowsOutsideScope: overrides.roleRowsOutsideScope ?? 0,
      messageLikeBlocks: overrides.messageLikeBlocks ?? 0
    };
  };

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

  it('fails closed when a candidate timestamp does not place the message on the timeline', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z'), candidate('Unparseable', 'later')],
      diagnostics: diagnostics(),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'undated_messages' });
  });

  it('fails closed when an attributed row was reported without a usable timestamp', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ undatedMessages: 1, candidateTextBudgetExceeded: false }),
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

  it('keeps the relative order of candidates that share one timestamp', () => {
    const outcome = selectMessengerThreadWindow({
      candidates: [
        candidate('First', '2026-09-14T10:00:00.000Z'),
        candidate('Second', '2026-09-14T10:00:00.000Z'),
        candidate('Newest', '2026-09-14T11:00:00.000Z')
      ],
      diagnostics: diagnostics({ renderedRows: 3, scannedRows: 3 }),
      maxMessages: 50
    });
    expect(outcome).toEqual({
      kind: 'window',
      messages: [
        { sender: 'you', text: 'First', sentAt: '2026-09-14T10:00:00.000Z' },
        { sender: 'you', text: 'Second', sentAt: '2026-09-14T10:00:00.000Z' },
        { sender: 'you', text: 'Newest', sentAt: '2026-09-14T11:00:00.000Z' }
      ],
      truncated: false
    });
  });

  it('returns an empty window when the window bound is zero', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ renderedRows: 1, scannedRows: 1 }),
      maxMessages: 0
    })).toEqual({ kind: 'window', messages: [], truncated: true });
  });

  it('fails closed when the extraction reports no diagnostics', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'missing_diagnostics' });
  });

  it('fails closed when the scan did not examine every rendered row', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ scannedRows: 1, renderedRows: 2 }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_scan' });
  });

  it('fails closed when the read collected more candidate text than its budget', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ candidateTextBudgetExceeded: true }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_scan' });
  });

  it('fails closed when the page reports no size for its message set', () => {
    // A page that declares no set size gives no way to tell the rendered rows apart from a
    // window of a longer thread, so the newest end of the thread is not proven.
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ declaredSetSize: undefined }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'missing_set_accounting' });
  });

  it('fails closed when a rendered row attests no membership in the declared set', () => {
    // A row of another set — a nested list, a grid of unrelated rows — can make the rendered
    // count match the declared size by coincidence, so every row must attest its membership.
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ renderedRows: 3, scannedRows: 3, declaredSetSize: 3, attestedRows: 2 }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('fails closed when the scope declares conflicting set sizes', () => {
    // The container and the rows describe different sets, so the scope holds more than one set.
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ setSizeConflict: true }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('fails closed when the declared set size is larger than the rendered rows', () => {
    // The virtualized-subset case: the page declared a longer set than it rendered, so the
    // rows the read examined are a window and the newest message may not be among them.
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ renderedRows: 3, scannedRows: 3, declaredSetSize: 120 }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('fails closed when the declared set size is smaller than the rendered rows', () => {
    // A declared size that counts fewer items than the rows carry is a stale or fabricated
    // count, so the rendered rows cannot be certified as the whole set.
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({ renderedRows: 3, scannedRows: 3, declaredSetSize: 1 }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('fails closed when two rows claim the same position in the set', () => {
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({
        renderedRows: 3,
        scannedRows: 3,
        declaredSetSize: 3,
        positionedRows: 3,
        distinctPositions: 2,
        newestPosition: 3
      }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('fails closed when the newest declared position stops before the end of the set', () => {
    // The positioned rows do not reach the declared size, so the set the page declared is
    // longer than the rows that carry its accounting.
    expect(selectMessengerThreadWindow({
      candidates: [candidate('Dated', '2026-09-14T10:00:00.000Z')],
      diagnostics: diagnostics({
        renderedRows: 3,
        scannedRows: 3,
        declaredSetSize: 3,
        positionedRows: 2,
        distinctPositions: 2,
        newestPosition: 2
      }),
      maxMessages: 50
    })).toEqual({ kind: 'unproven', reason: 'incomplete_rendered_set' });
  });

  it('proves the window when the declared set size and the declared positions agree', () => {
    const outcome = selectMessengerThreadWindow({
      candidates: [
        candidate('Older', '2026-09-14T10:00:00.000Z'),
        candidate('Newest', '2026-09-14T12:00:00.000Z')
      ],
      diagnostics: diagnostics({
        renderedRows: 2,
        scannedRows: 2,
        declaredSetSize: 2,
        positionedRows: 2,
        distinctPositions: 2,
        newestPosition: 2
      }),
      maxMessages: 50
    });
    expect(outcome).toEqual({
      kind: 'window',
      messages: [
        { sender: 'you', text: 'Older', sentAt: '2026-09-14T10:00:00.000Z' },
        { sender: 'you', text: 'Newest', sentAt: '2026-09-14T12:00:00.000Z' }
      ],
      truncated: false
    });
  });
});
