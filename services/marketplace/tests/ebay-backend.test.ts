import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EbayShoppingBackend } from '../src/ebay-backend.js';
import { ProviderError } from '../src/backend.js';
import { productOfferSchema, shoppingFetchInputSchema, shoppingSearchInputSchema } from '../src/domain.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ebay/${name}`, import.meta.url), 'utf8'));
let server: Server;
let origin = '';
let mode = 'normal';
let lastPath = '';
let lastMarketplaceId = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    lastPath = pathname;
    const marketplaceHeader = req.headers['x-ebay-c-marketplace-id'];
    lastMarketplaceId = Array.isArray(marketplaceHeader) ? marketplaceHeader[0] ?? '' : marketplaceHeader ?? '';
    if (pathname.endsWith('/oauth2/token')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('token.json'))); return; }
    if (mode === 'hang') return;
    // A malformed fractional retry-after must still yield a typed RATE_LIMITED result with a
    // truncated integer hint, so the error is constructed rather than a schema TypeError.
    if (mode === 'rate-limited') { res.writeHead(429, { 'retry-after': '7' }); res.end(); return; }
    if (mode === 'rate-limited-fractional') { res.writeHead(429, { 'retry-after': '1.5' }); res.end(); return; }
    // Beyond the safe integer range: the hint is meaningless in seconds and the shared
    // metadata schema rejects it, so the client must drop it rather than break the error.
    if (mode === 'rate-limited-out-of-range') { res.writeHead(429, { 'retry-after': '1e21' }); res.end(); return; }
    if (mode === 'rate-limited-no-hint') { res.writeHead(429); res.end(); return; }
    if (mode === 'rate-limited-negative') { res.writeHead(429, { 'retry-after': '-5' }); res.end(); return; }
    if (pathname.endsWith('/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'unmappable'
        ? { itemSummaries: [{ itemId: 'invalid', title: 'No URL' }, { itemId: 'v1|123|1', itemWebUrl: 'https://www.ebay.com/itm/123', title: 'Synthetic Good Row' }] }
        : mode === 'coercion' ? coercionTrapPayload()
        : mode === 'variations' ? variationsPayload()
        : mode === 'conditions' ? conditionsPayload()
        : mode === 'malformed' ? { total: 3, warnings: [] }
        : fixture('search-success.json')));
      return;
    }
    if (mode === 'missing-url') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ itemId: '123', title: 'Synthetic Missing URL' })); return; }
    if (mode === 'variations') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...fixture('item-success.json'), itemId: 'v1|555000|2', title: 'Synthetic Widget Variation Two' })); return; }
    if (mode === 'not-found') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('item-404.json'))); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('item-success.json')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
function backend() { return new EbayShoppingBackend({ clientId: 'synthetic', clientSecret: 'synthetic', baseUrl: origin }); }
const signal = () => new AbortController().signal;
const searchInput = shoppingSearchInputSchema.parse({ query: 'synthetic', limit: 10 });

function variationsPayload() {
  return { itemSummaries: [
    { itemId: 'v1|555000|1', itemWebUrl: 'https://www.ebay.com/itm/555000', title: 'Synthetic Widget Variation One', price: { value: '10.00', currency: 'USD' }, condition: 'New' },
    { itemId: 'v1|555000|2', itemWebUrl: 'https://www.ebay.com/itm/555000', title: 'Synthetic Widget Variation Two', price: { value: '12.00', currency: 'USD' }, condition: 'New' }
  ] };
}

function conditionsPayload() {
  const row = (itemId: string, condition: string) => ({ itemId, itemWebUrl: `https://www.ebay.com/itm/${itemId.split('|')[1]}`, title: `Synthetic ${condition}`, price: { value: '5.00', currency: 'USD' }, condition });
  return { itemSummaries: [
    row('v1|6001|0', 'Brand New'),
    row('v1|6002|0', 'Like New'),
    row('v1|6003|0', 'Used - Like New'),
    row('v1|6004|0', 'New other (see details)'),
    row('v1|6005|0', 'Excellent - Refurbished'),
    row('v1|6006|0', 'For parts or not working'),
    row('v1|6007|0', 'Mystery Condition')
  ] };
}

function coercionTrapPayload() {
  return { itemSummaries: [
    // Null price value must stay null (Number(null) is 0); renewed is refurbished; the
    // FREE shipping marker is shippingCostType on the option, not a field on the cost.
    { itemId: 'v1|2001|0', itemWebUrl: 'https://www.ebay.com/itm/2001', title: 'Synthetic Null Price', price: { value: null, currency: 'USD' }, condition: 'Renewed', shippingOptions: [{ shippingCostType: 'FREE', shippingCost: { value: '0.00', currency: 'USD' } }] },
    // An unspecified shipping value is not free (Number('') is 0).
    { itemId: 'v1|2003|0', itemWebUrl: 'https://www.ebay.com/itm/2003', title: 'Synthetic Empty Shipping', price: { value: '5.00', currency: 'USD' }, shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '', currency: 'USD' } }] }
  ] };
}

describe('EbayShoppingBackend', () => {
  it('maps search offers into valid ProductOffer records', async () => {
    mode = 'normal';
    const offers = await backend().search(searchInput, signal());
    expect(offers).toHaveLength(2);
    expect(productOfferSchema.parse(offers[0])).toMatchObject({ id: 'v1|123456789012|0', availability: 'unknown', condition: 'new', shipping_cost: 3.25, shipping_currency: 'USD', location: 'Sampleton, US', state: 'active' });
  });
  it('fetches item details by legacy id', async () => {
    mode = 'normal';
    const offer = await backend().fetch(shoppingFetchInputSchema.parse({ id: '123456789012' }), signal());
    expect(offer).toMatchObject({ id: 'v1|123456789012|0', availability: 'in_stock' });
    productOfferSchema.parse(offer);
  });
  it('preserves variation identity: two variants of one listing stay distinct, and a RESTful id fetches the exact variant', async () => {
    mode = 'variations';
    const offers = await backend().search(searchInput, signal());
    expect(offers.map((offer) => offer.id)).toEqual(['v1|555000|1', 'v1|555000|2']);
    const offer = await backend().fetch(shoppingFetchInputSchema.parse({ id: 'v1|555000|2' }), signal());
    expect(offer).toMatchObject({ id: 'v1|555000|2', title: 'Synthetic Widget Variation Two' });
    expect(lastPath).toBe(`/buy/browse/v1/item/${encodeURIComponent('v1|555000|2')}`);
  });
  it('sends the marketplace header in eBay\'s underscore form', async () => {
    mode = 'normal';
    await backend().search(searchInput, signal());
    expect(lastMarketplaceId).toBe('EBAY_US');
  });
  it('rejects a mixed valid/invalid search page and fails closed on a fetch without URL', async () => {
    mode = 'unmappable';
    await expect(backend().search(searchInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The eBay search response contained an unmappable item row.'
    });
    mode = 'missing-url';
    await expect(backend().fetch(shoppingFetchInputSchema.parse({ id: '123' }), signal())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
  it('refuses coercion traps and keeps attribution only where eBay states it', async () => {    mode = 'coercion';
    const offers = await backend().search(searchInput, signal());
    expect(offers).toHaveLength(2);
    expect(productOfferSchema.parse(offers[0])).toMatchObject({
      id: 'v1|2001|0', price: null, currency: 'USD', condition: 'refurbished', shipping_cost: 0, shipping_currency: 'USD'
    });
    expect(offers[1]).toMatchObject({ id: 'v1|2003|0', shipping_cost: null, shipping_currency: null });
  });
  it('maps eBay condition labels precisely: Like New is used, ambiguous is unknown', async () => {
    mode = 'conditions';
    const offers = await backend().search(searchInput, signal());
    expect(Object.fromEntries(offers.map((offer) => [offer.title, offer.condition]))).toEqual({
      'Synthetic Brand New': 'new',
      'Synthetic Like New': 'used',
      'Synthetic Used - Like New': 'used',
      'Synthetic New other (see details)': 'new',
      'Synthetic Excellent - Refurbished': 'refurbished',
      'Synthetic For parts or not working': 'unknown',
      'Synthetic Mystery Condition': 'unknown'
    });
  });
  it('rejects a search response with no itemSummaries and no zero total as schema drift', async () => {
    mode = 'malformed';
    await expect(backend().search(searchInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The eBay search response was not recognized.'
    });
  });
  it('maps a 404 to the house no-result case so the tool layer reports NOT_FOUND', async () => {
    mode = 'not-found';
    await expect(backend().fetch(shoppingFetchInputSchema.parse({ id: '123' }), signal())).resolves.toBeNull();
    expect(ProviderError).toBeDefined();
  });
  it('honors an already-aborted signal as TIMEOUT', async () => {
    mode = 'hang';
    const controller = new AbortController(); controller.abort(new Error('caller aborted'));
    await expect(backend().search(searchInput, controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('maps a 429 with an integer retry-after to RATE_LIMITED carrying the preserved hint', async () => {
    mode = 'rate-limited';
    await expect(backend().search(searchInput, signal())).rejects.toMatchObject({
      code: 'RATE_LIMITED', metadata: { retry_after: 7 }
    });
  });
  it('maps a 429 with a fractional retry-after to RATE_LIMITED carrying a truncated hint', async () => {
    mode = 'rate-limited-fractional';
    const rejection = backend().search(searchInput, signal());
    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    await expect(rejection).rejects.toMatchObject({
      code: 'RATE_LIMITED', metadata: { retry_after: 1 }
    });
  });
  it('maps a 429 with a beyond-safe-range retry-after to RATE_LIMITED with no retry hint', async () => {
    mode = 'rate-limited-out-of-range';
    const rejection = backend().search(searchInput, signal());
    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    const error = await rejection.then(
      () => { throw new Error('expected the eBay search to reject'); },
      (thrown: unknown) => thrown as ProviderError
    );
    expect(error.code).toBe('RATE_LIMITED');
    // No hint at all beats a fabricated one: the out-of-range value is dropped, not clamped.
    expect(error.metadata.retry_after).toBeUndefined();
    expect('retry_after' in error.metadata).toBe(false);
  });
  it('maps a 429 with no retry-after to RATE_LIMITED without a retry hint', async () => {
    mode = 'rate-limited-no-hint';
    const rejection = backend().search(searchInput, signal());
    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    const error = await rejection.then(
      () => { throw new Error('expected the eBay search to reject'); },
      (thrown: unknown) => thrown as ProviderError
    );
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.metadata.retry_after).toBeUndefined();
    expect('retry_after' in error.metadata).toBe(false);
  });
  it('maps a 429 with a negative retry-after to RATE_LIMITED without a retry hint', async () => {
    mode = 'rate-limited-negative';
    const rejection = backend().search(searchInput, signal());
    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    const error = await rejection.then(
      () => { throw new Error('expected the eBay search to reject'); },
      (thrown: unknown) => thrown as ProviderError
    );
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.metadata.retry_after).toBeUndefined();
    expect('retry_after' in error.metadata).toBe(false);
  });
});

describe('EbayShoppingBackend unmappable search rows (#236)', () => {
  const VALID_ROW = { itemId: 'v1|7001|0', itemWebUrl: 'https://www.ebay.com/itm/7001', title: 'Synthetic Valid', price: { value: '5.00', currency: 'USD' } };
  const NO_CURRENCY_ROW = { itemId: 'v1|2002|0', itemWebUrl: 'https://www.ebay.com/itm/2002', title: 'Synthetic No Currency', price: { value: '12.50' } };
  const drift = { code: 'UPSTREAM_ERROR', message: 'The eBay search response contained an unmappable item row.' };
  const searchPayload = (itemSummaries: unknown[]) => ({ itemSummaries, total: itemSummaries.length });
  const stubBackend = (payload: unknown) => new EbayShoppingBackend({
    clientId: 'synthetic',
    clientSecret: 'synthetic',
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async (input) => Response.json(
      String(input).includes('/oauth2/token') ? { access_token: 'synthetic', expires_in: 3600 } : payload
    )
  });

  it.each([
    ['a null row', [null]],
    ['a row missing required fields', [{ itemId: 'broken', title: 'Missing URL' }]],
    ['a row rejected by the public offer schema (a non-URL itemWebUrl string)', [{ itemId: 'broken', itemWebUrl: 'not-a-url', title: 'Bad URL' }]],
    ['a numeric price with no currency marker (unattributable, never a fabricated currency)', [NO_CURRENCY_ROW]],
    ['an all-invalid nonempty page', [null, { itemId: 'broken', title: 'Missing URL' }]],
    ['a mixed valid/invalid page', [VALID_ROW, { itemId: 'broken', title: 'Missing URL' }]]
  ])('rejects %s as a typed upstream error instead of a successful omission', async (_label, itemSummaries) => {
    await expect(stubBackend(searchPayload(itemSummaries)).search(searchInput, signal())).rejects.toMatchObject(drift);
  });

  it.each([
    ['a non-zero total', { itemSummaries: [], total: 3 }],
    ['no total at all', { itemSummaries: [] }]
  ])('rejects an empty itemSummaries array carrying %s as schema drift', async (_label, payload) => {
    await expect(stubBackend(payload).search(searchInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The eBay search response was not recognized.'
    });
  });

  it('still returns legitimate empty and valid search pages', async () => {
    // eBay omits itemSummaries on zero-result responses, and may serve it empty with total: 0.
    await expect(stubBackend({ total: 0 }).search(searchInput, signal())).resolves.toEqual([]);
    await expect(stubBackend({ itemSummaries: [], total: 0 }).search(searchInput, signal())).resolves.toEqual([]);
    const offers = await stubBackend(searchPayload([VALID_ROW, { ...VALID_ROW, itemId: 'v1|7002|0', itemWebUrl: 'https://www.ebay.com/itm/7002' }])).search(searchInput, signal());
    expect(offers.map((offer) => offer.id)).toEqual(['v1|7001|0', 'v1|7002|0']);
  });

  it('stops at the limit and never inspects rows past it', async () => {
    const limited = shoppingSearchInputSchema.parse({ query: 'synthetic', limit: 1 });
    // The limit break precedes the second row, so only the examined prefix must map.
    await expect(stubBackend(searchPayload([VALID_ROW, null])).search(limited, signal())).resolves.toEqual([expect.objectContaining({ id: 'v1|7001|0' })]);
  });
});

describe('EbayShoppingBackend requestTimeoutMs validation', () => {
  const options = () => ({ clientId: 'synthetic', clientSecret: 'synthetic', baseUrl: origin });
  // setTimeout coerces delays above 2^31-1 ms to 1, so an out-of-range value must fail at
  // construction rather than abort every request instantly (#119).
  it.each([2_147_483_648, 4_294_967_296, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])(
    'rejects %s at construction', (requestTimeoutMs) => {
      expect(() => new EbayShoppingBackend(options(), { requestTimeoutMs })).toThrow(RangeError);
    }
  );
  it('accepts the 2^31-1 upper bound', () => {
    expect(() => new EbayShoppingBackend(options(), { requestTimeoutMs: 2_147_483_647 })).not.toThrow();
  });
  it.each([0, -1, 1.5, Number.NaN])('keeps rejecting invalid %s', (requestTimeoutMs) => {
    expect(() => new EbayShoppingBackend(options(), { requestTimeoutMs })).toThrow(RangeError);
  });
});
