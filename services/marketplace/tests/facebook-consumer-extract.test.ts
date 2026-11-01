import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { extractConsumerMenuPage, CONSUMER_EXTRACT_LIMITS, type ExtractedConsumerMenuPage } from '../src/facebook-consumer-extract.js';
import { classifyConsumerMenuPage, interpretConsumerMenuPage } from '../src/facebook-consumer-parse.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

let browser: Browser;
let page: Page;

const loadFixture = (name: string): string => readFileSync(new URL(`./fixtures/facebook-consumer/${name}`, import.meta.url), 'utf8');
const BASE = 'https://www.facebook.com';

async function extractOf(html: string): Promise<ExtractedConsumerMenuPage> {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return page.evaluate(extractConsumerMenuPage, { limits: CONSUMER_EXTRACT_LIMITS });
}

function interpret(extracted: ExtractedConsumerMenuPage) {
  return interpretConsumerMenuPage({
    // setContent pages live at about:blank, so the helper pins the verified address the backend
    // would have navigated to; the containment tests below override it explicitly.
    page: { ...extracted, url: `${BASE}/`, pathname: '/' },
    baseUrl: BASE
  });
}

describe.skipIf(!browserAvailable)('Facebook consumer menu extraction', () => {
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

  it('extracts region-scoped rows with route provenance and attributed fields, and the interpreter deduplicates keys', async () => {
    const extracted = await extractOf(loadFixture('menu-normal.html'));
    expect(extracted.chatsRegionCount).toBe(1);
    expect(extracted.regionRowCount).toBe(5);
    // The extractor keeps every linked row raw, including the repeated key; the interpreter owns
    // deduplication, so the observation stays evidence rather than a partially processed result.
    expect(extracted.rows).toHaveLength(4);
    // Field attribution per the 2026-10-31 field-semantics record: first text span is the
    // participant label, second is the snippet; the separator and the timestamp (the row's
    // single abbr) are excluded, and the presence label never enters the searchable fields.
    expect(extracted.rows[0]).toEqual({
      threadId: '111111111111111',
      route: 'plain',
      participants: ['Synthetic Alpha'],
      preview: 'Is the fixture bike available?'
    });
    expect(extracted.rows[1]).toEqual({
      threadId: '222222222222222',
      route: 'e2ee',
      participants: ['Synthetic Beta'],
      preview: 'The E2EE route keeps its provenance.'
    });
    expect(extracted.rows[2]?.participants).toEqual(['Synthetic Gamma']);
    expect(extracted.rows[3]?.threadId).toBe('111111111111111');
    expect(extracted.rowsScanSaturated).toBe(false);
    expect(extracted.duplicateKeyRows).toBe(0);
    expect(extracted.malformedRows).toBe(0);
    expect(classifyConsumerMenuPage(extracted)).toBe('menu');

    const outcome = interpret(extracted);
    expect(outcome.kind).toBe('menu');
    if (outcome.kind !== 'menu') return;
    // The interpreter returns the FULL deduplicated window; the callers apply their own return
    // limits, so a search can never silently omit a later observed row (#186 review).
    expect(outcome.threads).toHaveLength(3);
    expect(outcome.threads.map(({ thread_id, route }) => ({ thread_id, route }))).toEqual([
      { thread_id: '111111111111111', route: 'plain' },
      { thread_id: '222222222222222', route: 'e2ee' },
      { thread_id: '333333333333333', route: 'plain' }
    ]);
    expect(outcome.threads[0]?.participants).toEqual(['Synthetic Alpha']);
    expect(outcome.threads[0]?.preview).toBe('Is the fixture bike available?');
  });

  it('recognizes an explicitly empty menu and never mistakes a changed layout for one', async () => {
    const empty = await extractOf(loadFixture('menu-empty.html'));
    expect(classifyConsumerMenuPage(empty)).toBe('empty');
    expect(interpret(empty).kind).toBe('empty');

    const noRegion = await extractOf(loadFixture('menu-no-region.html'));
    expect(noRegion.chatsRegionCount).toBe(0);
    expect(classifyConsumerMenuPage(noRegion)).toBe('unknown');
    expect(interpret(noRegion)).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('fails closed on conflicting keys, malformed keys, a saturated row scan, and structure drift', async () => {
    const conflicting = await extractOf(loadFixture('menu-conflicting-keys.html'));
    expect(conflicting.duplicateKeyRows).toBe(1);
    expect(interpret(conflicting)).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });

    const malformed = await extractOf(loadFixture('menu-malformed-key.html'));
    expect(malformed.malformedRows).toBe(1);
    expect(malformed.rows).toHaveLength(1);
    expect(interpret(malformed)).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });

    // A row whose text shape does not match the verified field contract (here: two timestamps
    // where the contract allows the single abbr) is unattributable — the observation fails
    // closed instead of flattening the row into a searchable value (#186 review).
    const drifted = await extractOf(loadFixture('menu-structure-drift.html'));
    expect(drifted.malformedRows).toBe(1);
    expect(drifted.rows).toHaveLength(1);
    expect(interpret(drifted)).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });

    // A region with more rows than the scan bound leaves rows unexamined: untrusted observation.
    const rows = Array.from({ length: CONSUMER_EXTRACT_LIMITS.maxRowsScan + 10 }, (_, index) => {
      const key = String(400000000000000 + index);
      return `<div role="row"><a href="/messages/t/${key}/"><span>Row ${index}</span><span>Body ${index}</span><span>·</span><abbr>2h</abbr></a></div>`;
    }).join('');
    const saturated = await extractOf(`<!doctype html><html><body><div role="banner"><div role="button" aria-label="Messenger" style="width:40px;height:40px"></div></div><div role="grid" aria-label="Chats">${rows}</div><a href="/logout">Log out</a></body></html>`);
    expect(saturated.rowsScanSaturated).toBe(true);
    expect(interpret(saturated)).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('classifies auth states as typed errors, not as menu outcomes', async () => {
    const login = await extractOf(loadFixture('menu-login.html'));
    expect(classifyConsumerMenuPage(login)).toBe('login');
    expect(interpret(login)).toMatchObject({ kind: 'error', code: 'LOGIN_REQUIRED' });

    const dormant = await extractOf(loadFixture('menu-captcha-dormant.html'));
    // Dormant captcha markup is neither a challenge nor trusted content (#168 gate): unknown.
    expect(classifyConsumerMenuPage(dormant)).toBe('unknown');
    expect(interpret(dormant)).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('contains a load that navigated into a conversation, without inspecting it', async () => {
    const extracted = await extractOf(loadFixture('menu-normal.html'));
    const navigated = interpretConsumerMenuPage({
      page: { ...extracted, url: 'https://www.facebook.com/messages/t/111111111111111/', pathname: '/messages/t/111111111111111/' },
      baseUrl: BASE
    });
    expect(navigated).toMatchObject({
      kind: 'error',
      code: 'UPSTREAM_ERROR',
      message: 'The Facebook Messenger menu load navigated into a conversation; the read was aborted without inspecting it.'
    });

    const elsewhere = interpretConsumerMenuPage({
      page: { ...extracted, url: 'https://www.facebook.com/other/', pathname: '/other/' },
      baseUrl: BASE
    });
    expect(elsewhere).toMatchObject({
      kind: 'error',
      code: 'UPSTREAM_ERROR',
      message: 'The Facebook Messenger menu was not reached at the expected address.'
    });
  });

  it('returns the full observed window to the callers, who own the return limits', async () => {
    const extracted = await extractOf(loadFixture('menu-normal.html'));
    const outcome = interpret(extracted);
    expect(outcome.kind).toBe('menu');
    if (outcome.kind !== 'menu') return;
    // Three unique rows pass through whole even though a caller could have asked for fewer; the
    // backend's limit tests assert the slicing and cap-truthful truncation on top of this.
    expect(outcome.threads).toHaveLength(3);
  });

  it('rejects a menu reached at another origin', async () => {
    const extracted = await extractOf(loadFixture('menu-normal.html'));
    const outcome = interpretConsumerMenuPage({
      page: { ...extracted, url: 'https://www.example.com/' },
      baseUrl: BASE
    });
    expect(outcome).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });
});
