import { listingSchema, type Listing, type ProviderErrorCode } from './domain.js';
import type {
  ExtractedListingCard,
  ExtractedMarketplaceItem,
  ExtractedMarketplacePage
} from './facebook-marketplace-extract.js';
import {
  buildMarketplaceItemUrl,
  parseMarketplaceItemId,
  type FacebookMarket
} from './facebook-marketplace-url.js';

export const MARKETPLACE_PAGE_KINDS = ['results', 'no_results', 'login', 'checkpoint', 'captcha', 'rate_limited', 'unknown'] as const;
export type MarketplacePageKind = typeof MARKETPLACE_PAGE_KINDS[number];

export function classifyMarketplacePage(page: ExtractedMarketplacePage): MarketplacePageKind {
  // Precedence is deliberate: captcha, checkpoint, login, rate limit, cards, no-results notice, then unknown.
  // Captcha requires visible challenge evidence (#168), mirroring the session probe's gate on
  // classifyFacebookSession (#148): a dormant captcha widget or arbitrary feed text mentioning
  // "captcha" is not proof of a challenge, so the page is never `usable`, but it is also not
  // trusted content — it classifies `unknown` (a typed upstream error) rather than falling
  // through to the success kinds below, exactly where the probe reports `ambiguous`. The breaker
  // never counts the downgraded page, because `unknown` carries no auth-class code. A snapshot
  // with no visibility observation keeps the conservative captcha verdict, as the probe does.
  if (page.signals.hasCaptcha) return page.signals.captchaVisible === false ? 'unknown' : 'captcha';
  if (page.signals.hasCheckpoint) return 'checkpoint';
  if (page.signals.hasLoginForm) return 'login';
  if (page.signals.hasRateLimitNotice) return 'rate_limited';
  if (page.cards.length > 0) return 'results';
  if (page.signals.hasNoResultsNotice) return 'no_results';
  return 'unknown';
}

export const PRICE_PARSE_STATUSES = ['ok', 'absent', 'malformed'] as const;
export interface MarketplacePriceParse {
  status: typeof PRICE_PARSE_STATUSES[number];
  price: number | null;
  currency: string;
  marker?: string;
}

export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  'CA$': 'CAD',
  'A$': 'AUD',
  'US$': 'USD',
  'NZ$': 'NZD',
  'HK$': 'HKD',
  'S$': 'SGD',
  'R$': 'BRL',
  'MX$': 'MXN',
  'C$': 'CAD',
  'zł': 'PLN',
  kr: 'SEK',
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR'
};

const ISO_CURRENCIES = ['USD', 'CAD', 'AUD', 'GBP', 'EUR', 'JPY', 'INR', 'MXN', 'BRL', 'CHF', 'NZD', 'HKD', 'SGD', 'KRW', 'SEK', 'NOK', 'DKK', 'PLN', 'TRY', 'ZAR'] as const;
export const COMMA_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['EUR', 'TRY', 'BRL', 'SEK', 'NOK', 'DKK', 'PLN']);
const DOLLAR_CURRENCIES = new Set(['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN', 'BRL']);
const SORTED_SYMBOLS = Object.keys(CURRENCY_SYMBOLS).sort((a, b) => b.length - a.length);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SYMBOL_PATTERN = SORTED_SYMBOLS.map((symbol) => {
  const escaped = escapeRegExp(symbol);
  return /^[\p{L}]+$/u.test(symbol) ? `(?<![A-Za-z])${escaped}(?![A-Za-z])` : escaped;
});
const CURRENCY_SYMBOL_PATTERN = `(?:${SYMBOL_PATTERN.join('|')})`;
// Exact three-digit whitespace groups are treated as thousands separators; this favors common prices over separate adjacent numbers.
const NUMBER_TOKEN_PATTERN = '[+\\-]?(?:\\d{1,3}(?:[\\s\\u00a0]\\d{3})+|\\d)(?:[\\d.,]*\\d)?';
const NUMBER_AFTER_PATTERN = new RegExp(`^\\s*(${NUMBER_TOKEN_PATTERN})(?![\\s\\u00a0]*\\d)(?!\\p{L})(?![.,]\\d)(?:[.,](?!\\d))?`, 'u');
const NUMBER_BEFORE_PATTERN = new RegExp(`(?:^|[^\\d\\s\\u00a0])\\s*(${NUMBER_TOKEN_PATTERN})\\s*$`);
const MARKER_PATTERN = new RegExp(
  `(?:${CURRENCY_SYMBOL_PATTERN}|\\b(?:${ISO_CURRENCIES.join('|')})\\b)`,
  'gu'
);

function makePriceResult(status: MarketplacePriceParse['status'], price: number | null, currency: string, marker?: string): MarketplacePriceParse {
  return { status, price, currency, ...(marker !== undefined ? { marker } : {}) };
}

function parseNumberToken(token: string, currency: string): number | null {
  if (!/^[+\-]?\d(?:[\d.,]|[\s\u00a0]\d{3})*$/.test(token) || token.startsWith('-')) return null;
  let normalized = token.replace(/^\+/, '').replace(/[\s\u00a0]/g, '');
  const comma = normalized.lastIndexOf(',');
  const dot = normalized.lastIndexOf('.');

  if (comma !== -1 && dot !== -1) {
    const decimalSeparator = comma > dot ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    const decimalIndex = normalized.lastIndexOf(decimalSeparator);
    const integerPart = normalized.slice(0, decimalIndex);
    const fraction = normalized.slice(decimalIndex + 1);
    if (!/^\d+$/.test(fraction) || !validGroupedInteger(integerPart, groupingSeparator)) return null;
    normalized = integerPart.split(groupingSeparator).join('') + '.' + fraction;
  } else if (comma !== -1 || dot !== -1) {
    const separator = comma !== -1 ? ',' : '.';
    const parts = normalized.split(separator);
    if (parts.some((part) => !/^\d+$/.test(part))) return null;
    if (parts.length === 2 && parts[1]?.length === 3) {
      const isDecimalSeparator = separator === ',' ? COMMA_DECIMAL_CURRENCIES.has(currency) : !COMMA_DECIMAL_CURRENCIES.has(currency);
      if (isDecimalSeparator) return null;
      if (!validGroupedInteger(normalized, separator)) return null;
      normalized = normalized.split(separator).join('');
    } else if (parts.length === 2) {
      normalized = `${parts[0]}.${parts[1]}`;
    } else {
      if (!validGroupedInteger(normalized, separator)) return null;
      normalized = normalized.split(separator).join('');
    }
  }

  const integerPart = normalized.split('.')[0] ?? '';
  try {
    const integerValue = BigInt(integerPart);
    if (integerValue > BigInt(Number.MAX_SAFE_INTEGER)
      || integerValue === BigInt(Number.MAX_SAFE_INTEGER) && normalized.includes('.') && /[1-9]/.test(normalized.split('.')[1] ?? '')) {
      return null;
    }
  } catch {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

function validGroupedInteger(value: string, separator: string): boolean {
  const parts = value.split(separator);
  if (parts.length === 1) return /^\d+$/.test(parts[0] ?? '');
  return /^\d{1,3}$/.test(parts[0] ?? '') && parts.slice(1).every((part) => /^\d{3}$/.test(part));
}

function markerCurrency(marker: string, marketCurrency: string): string {
  if (marker === '$') return DOLLAR_CURRENCIES.has(marketCurrency) ? marketCurrency : 'USD';
  return CURRENCY_SYMBOLS[marker] ?? marker;
}

interface PriceToken {
  value: number;
  currency: string;
  marker?: string;
}

interface CollectedPriceTokens {
  tokens: PriceToken[];
  malformed: { currency: string; marker: string } | null;
}

function collectPriceTokens(text: string, marketCurrency: string): CollectedPriceTokens {
  // Bare numbers are intentionally not prices: years, mileage, and distances must not become listing prices.
  const boundedText = text.slice(0, 600);
  const tokens: PriceToken[] = [];
  let malformedCurrency: string | null = null;
  let malformedMarker: string | null = null;

  for (const line of boundedText.split('\n')) {
    if (/^free\s*[.!]?$/i.test(line.trim())) {
      tokens.push({ value: 0, currency: marketCurrency });
      continue;
    }

    MARKER_PATTERN.lastIndex = 0;
    for (const found of line.matchAll(MARKER_PATTERN)) {
      if (found.index === undefined) continue;
      const marker = found[0];
      const markerStart = found.index;
      const markerEnd = markerStart + marker.length;
      const before = line.slice(0, markerStart);
      const after = line.slice(markerEnd);
      const beforeMatch = before.match(NUMBER_BEFORE_PATTERN);
      const afterMatch = after.match(NUMBER_AFTER_PATTERN);
      const currency = markerCurrency(marker, marketCurrency);
      let numberToken: string | null;

      const isIsoCode = /^[A-Z]{3}$/.test(marker);
      if (isIsoCode) {
        numberToken = beforeMatch?.[1] ?? afterMatch?.[1] ?? null;
        if (!numberToken && /[$€£¥₹]/u.test(after)) {
          const afterSymbol = after.match(/^(?:\s*[$€£¥₹])+(.*)$/u)?.[1] ?? '';
          numberToken = afterSymbol.match(NUMBER_AFTER_PATTERN)?.[1] ?? null;
        }
      } else {
        numberToken = afterMatch?.[1] ?? beforeMatch?.[1] ?? null;
      }

      const hasAdjacentNumber = Boolean(/[+\-]?\d\s*$/.test(before)
        || /^\s*[+\-]?\s*\d/.test(after)
        || numberToken
        || /^\s*\d[\d.,]*\d\p{L}/u.test(after));
      if (!hasAdjacentNumber) continue;

      const signPrefixed = /-\s*$/.test(before) || /^\s*-\s*\d/.test(after);
      const price = numberToken && !signPrefixed ? parseNumberToken(numberToken, currency) : null;
      if (price !== null) {
        tokens.push({ value: price, currency, marker });
        continue;
      }
      if (malformedCurrency === null) {
        malformedCurrency = currency;
        malformedMarker = marker;
      }
    }
  }

  return {
    tokens,
    malformed: malformedCurrency !== null ? { currency: malformedCurrency, marker: malformedMarker ?? '' } : null
  };
}

export function parseMarketplacePrice(text: string, marketCurrency: string): MarketplacePriceParse {
  const collected = collectPriceTokens(text, marketCurrency);
  const first = collected.tokens[0];
  if (first) return makePriceResult('ok', first.value, first.currency, first.marker);
  return collected.malformed !== null
    ? makePriceResult('malformed', null, collected.malformed.currency, collected.malformed.marker)
    : makePriceResult('absent', null, marketCurrency);
}

export const MARKETPLACE_CARD_PRICE_STATUSES = ['ok', 'absent', 'malformed', 'ambiguous'] as const;

export interface MarketplaceCardPriceParse {
  status: typeof MARKETPLACE_CARD_PRICE_STATUSES[number];
  price: number | null;
  currency: string;
  marker?: string;
  /** Valid price tokens found in the bounded card text; a count only, never content (#182). */
  tokens: number;
}

/**
 * Search cards report a price only when the card text agrees with itself: a card whose text
 * carries more than one distinct valid price value (a bundle mention, a strikethrough, a
 * related item's price) cannot prove which one is the listing's price, so it reports no price
 * rather than the first marker's guess (#182). Repeated identical prices (the same amount
 * rendered twice) stay unambiguous. The fetched detail page parses a dedicated price element
 * and keeps the first-token rule through `parseMarketplacePrice`.
 */
export function parseMarketplaceCardPrice(text: string, marketCurrency: string): MarketplaceCardPriceParse {
  const collected = collectPriceTokens(text, marketCurrency);
  const first = collected.tokens[0];
  const distinct = new Set(collected.tokens.map((token) => `${token.currency}:${token.value}`));
  if (distinct.size > 1) {
    return { status: 'ambiguous', price: null, currency: marketCurrency, tokens: collected.tokens.length };
  }
  if (first) {
    return {
      status: 'ok',
      price: first.value,
      currency: first.currency,
      ...(first.marker !== undefined ? { marker: first.marker } : {}),
      tokens: collected.tokens.length
    };
  }
  return collected.malformed !== null
    ? { status: 'malformed', price: null, currency: collected.malformed.currency, marker: collected.malformed.marker, tokens: 0 }
    : { status: 'absent', price: null, currency: marketCurrency, tokens: 0 };
}

export interface ParseMarketplaceInput {
  page: ExtractedMarketplacePage;
  baseUrl: string;
  market: FacebookMarket;
  limit: number;
  minPrice?: number;
  maxPrice?: number;
}

export interface MarketplaceParseStats {
  cardsSeen: number;
  structurallyValid: number;
  duplicates: number;
  skipReasons: Readonly<Record<string, number>>;
  /** Cards whose text carried more than one distinct valid price value; their price is null (#182). */
  ambiguousPrices: number;
  /** Valid price tokens per card reaching price parsing, in parse order; counts only, never content (#182). */
  cardPriceTokens: readonly number[];
}

export interface MarketplaceParseResult {
  listings: readonly Listing[];
  stats: MarketplaceParseStats;
}

const LOCATION_PATTERN = /^[A-Za-z .'-]+,\s*[A-Z]{2}$/;
const ISO_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const NOISE_LINE_PATTERN = /^(?:sponsored|sold|pending|removed|no longer available|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|new listing|delivery available|free shipping|promoted)$/i;
const MILEAGE_LINE_PATTERN = /^\d+(?:,\d{3})*(?:\.\d+)?\s*(?:k\s*)?(?:miles?|mi|km)\b$/i;

function isNoiseLine(line: string): boolean {
  const normalized = line.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
  return NOISE_LINE_PATTERN.test(normalized) || MILEAGE_LINE_PATTERN.test(normalized);
}

function cleanLines(card: ExtractedListingCard): string[] {
  return card.text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function isPriceLine(line: string, currency: string): boolean {
  return parseMarketplacePrice(line, currency).status !== 'absent';
}

function lineIsLocation(line: string): boolean {
  const stripped = line.replace(/\s+·\s+[^·]+$/, '').trim();
  return LOCATION_PATTERN.test(stripped);
}

function canonicalSellerUrl(value: string | null, baseUrl: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, baseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    // A seller link must stay on the page's own origin, or a page could carry an off-origin
    // /marketplace/profile-shaped link into the normalized listing.
    if (url.origin !== new URL(baseUrl).origin) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function parsePostedAt(value: string | null): string | null {
  if (!value || !ISO_OFFSET_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function extractState(text: string): Listing['state'] {
  for (const line of text.split('\n')) {
    const indicator = line.trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '').toLowerCase();
    if (indicator === 'sold') return 'sold';
    if (indicator === 'pending') return 'pending';
    if (indicator === 'removed' || indicator === 'no longer available') return 'removed';
  }
  // A search result cannot prove that a listing is active, so active is never emitted here.
  return 'unknown';
}

export function parseMarketplacePage(input: ParseMarketplaceInput): MarketplaceParseResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new RangeError('Limit must be an integer from 1 to 20');
  for (const [name, value] of [['minPrice', input.minPrice], ['maxPrice', input.maxPrice]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError(`${name} must be finite and non-negative`);
  }

  const skipReasons: Record<string, number> = {};
  const skip = (reason: string): void => { skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; };
  const candidates: Listing[] = [];
  const seenIds = new Set<string>();
  const cardPriceTokens: number[] = [];
  let structurallyValid = 0;
  let duplicates = 0;
  let ambiguousPrices = 0;

  for (const card of input.page.cards) {
    const id = parseMarketplaceItemId(card.itemHref);
    if (!id) {
      skip('missing_item_id');
      continue;
    }

    const lines = cleanLines(card);
    const priceResult = parseMarketplaceCardPrice(card.text, input.market.currency);
    cardPriceTokens.push(priceResult.tokens);
    if (priceResult.status === 'ambiguous') ambiguousPrices += 1;
    let locationIndex = -1;
    let location = input.market.label;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line && lineIsLocation(line)) {
        locationIndex = index;
        location = line.replace(/\s+·\s+[^·]+$/, '').trim();
        break;
      }
    }

    const heading = card.headingText?.trim() ?? '';
    // Prose-like headings can still be real titles; discard only exact known noise labels.
    let sourceTitle = heading && !isNoiseLine(heading) ? heading : '';
    if (!sourceTitle) {
      sourceTitle = lines.find((line) => !isPriceLine(line, input.market.currency)
        && !lineIsLocation(line)
        && !isNoiseLine(line)) ?? '';
    }
    if (!sourceTitle) {
      skip('missing_title');
      continue;
    }
    const title = sourceTitle.slice(0, 256);

    if (priceResult.status === 'malformed') {
      skip('malformed_price');
      continue;
    }
    if (lines.some((line) => /^Sponsored$/i.test(line))) {
      skip('sponsored');
      continue;
    }

    let url: string;
    try {
      url = buildMarketplaceItemUrl(input.baseUrl, id);
    } catch {
      skip('invalid_listing');
      continue;
    }

    const priceLineIndexes = new Set<number>();
    lines.forEach((line, index) => {
      if (isPriceLine(line, input.market.currency)) priceLineIndexes.add(index);
    });
    const titleLineIndexes = new Set<number>();
    lines.forEach((line, index) => {
      if (line.toLowerCase() === sourceTitle.toLowerCase()) titleLineIndexes.add(index);
    });
    const description = lines.filter((line, index) => index !== locationIndex
      && !priceLineIndexes.has(index)
      && !titleLineIndexes.has(index)
      && !isNoiseLine(line))
      .join(' · ').trim();
    const cleanDescription = !description || description.toLowerCase() === title.toLowerCase() ? '' : description.slice(0, 280);
    const images: string[] = [];
    const seenImages = new Set<string>();
    for (const value of card.imageUrls) {
      try {
        const image = new URL(value, input.baseUrl);
        if ((image.protocol !== 'http:' && image.protocol !== 'https:') || seenImages.has(image.href)) continue;
        seenImages.add(image.href);
        images.push(image.href);
        if (images.length >= 6) break;
      } catch {
        // Invalid image URLs are omitted rather than invalidating an otherwise usable search result.
      }
    }

    const sellerUrl = canonicalSellerUrl(card.profileHref, input.baseUrl);
    const candidate = {
      id,
      url,
      title,
      price: priceResult.status === 'ok' ? priceResult.price : null,
      currency: priceResult.status === 'ok' ? priceResult.currency : input.market.currency,
      location: location.slice(0, 256),
      // Relative labels are intentionally not converted: their reference time and timezone are unavailable.
      posted_at: parsePostedAt(card.timeDateTime),
      // Search cards do not distinguish an updated timestamp.
      updated_at: null,
      description: cleanDescription,
      images,
      seller: sellerUrl ? { url: sellerUrl } : null,
      state: extractState(card.text)
    };
    const parsed = listingSchema.safeParse(candidate);
    if (!parsed.success) {
      skip('invalid_listing');
      continue;
    }
    structurallyValid += 1;

    if (seenIds.has(id)) {
      duplicates += 1;
      skip('duplicate');
      continue;
    }
    seenIds.add(id);

    if ((input.minPrice !== undefined || input.maxPrice !== undefined) && parsed.data.price === null) {
      skip('price_filter');
      continue;
    }
    if (input.minPrice !== undefined && (parsed.data.price ?? -1) < input.minPrice) {
      skip('price_filter');
      continue;
    }
    if (input.maxPrice !== undefined && (parsed.data.price ?? Number.POSITIVE_INFINITY) > input.maxPrice) {
      skip('price_filter');
      continue;
    }
    candidates.push(parsed.data);
  }

  const listings = candidates.slice(0, input.limit);
  for (let index = input.limit; index < candidates.length; index += 1) skip('limit');
  return {
    listings,
    stats: { cardsSeen: input.page.cards.length, structurallyValid, duplicates, skipReasons, ambiguousPrices, cardPriceTokens }
  };
}

export type MarketplaceSearchOutcome =
  | { kind: 'listings'; listings: readonly Listing[]; stats: MarketplaceParseStats }
  | { kind: 'empty'; stats: MarketplaceParseStats }
  | { kind: 'error'; code: 'LOGIN_REQUIRED' | 'CAPTCHA_REQUIRED' | 'SESSION_INVALID' | 'RATE_LIMITED' | 'UPSTREAM_ERROR'; message: string };

export const MARKETPLACE_ITEM_KINDS = ['item', 'unavailable', 'login', 'checkpoint', 'captcha', 'rate_limited', 'unknown'] as const;
export type MarketplaceItemKind = typeof MARKETPLACE_ITEM_KINDS[number];

export function classifyMarketplaceItem(page: ExtractedMarketplaceItem): MarketplaceItemKind {
  // Same visible-evidence gate as classifyMarketplacePage (#168): dormant captcha markup or
  // page text quoting "captcha" is not a challenge and not a trusted listing — the page is
  // `unknown`, never `usable`, exactly where the probe reports `ambiguous`.
  if (page.signals.hasCaptcha) return page.signals.captchaVisible === false ? 'unknown' : 'captcha';
  if (page.signals.hasCheckpoint) return 'checkpoint';
  if (page.signals.hasLoginForm) return 'login';
  if (page.signals.hasRateLimitNotice) return 'rate_limited';
  // A rendered listing wins over the notice text. The notice regex runs over the whole page, and a
  // description is part of the page, so a seller writing "delivery is not available" must not turn
  // a live listing into a NOT_FOUND. The notice only disambiguates a title-less page between a
  // removed listing and an unrecognised layout; a removed listing that still renders a title is
  // caught by the scoped state scan instead.
  if (page.title?.trim()) return 'item';
  if (page.hasUnavailableNotice) return 'unavailable';
  return 'unknown';
}

export type MarketplaceItemOutcome =
  | { kind: 'listing'; listing: Listing }
  | { kind: 'unavailable' }
  | { kind: 'error'; code: ProviderErrorCode; message: string };

export interface ParseMarketplaceItemInput {
  page: ExtractedMarketplaceItem;
  id: string;
  url: string;
  fallbackCurrency?: string;
}

export function interpretMarketplaceItem(input: ParseMarketplaceItemInput): MarketplaceItemOutcome {
  const kind = classifyMarketplaceItem(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook Marketplace requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook Marketplace requires login.' };
  if (kind === 'rate_limited') return { kind: 'error', code: 'RATE_LIMITED', message: 'Facebook Marketplace temporarily limited this request.' };
  if (kind === 'unknown') return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace item page layout was not recognised.' };
  if (kind === 'unavailable') return { kind: 'unavailable' };

  const page = input.page;
  const priceResult = parseMarketplacePrice(page.priceText ?? '', input.fallbackCurrency ?? '');
  let currency = (priceResult.currency || input.fallbackCurrency || '').toUpperCase().slice(0, 3);
  if (priceResult.marker === '$') {
    // A bare "$" is ambiguous across dollar currencies, so only a resolved dollar market can identify it.
    const resolved = (input.fallbackCurrency ?? '').toUpperCase().slice(0, 3);
    if (!DOLLAR_CURRENCIES.has(resolved)) {
      return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace item uses an ambiguous dollar currency that could not be determined.' };
    }
    currency = resolved;
  }
  // An arbitrary configured market must never stand in for an unknown currency.
  if (!currency) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace item currency could not be determined.' };
  const sellerUrl = canonicalSellerUrl(page.sellerHref, input.url);
  const sellerName = page.sellerName?.trim();
  const seller = sellerUrl || sellerName
    ? { ...(sellerName ? { name: sellerName.slice(0, 128) } : {}), ...(sellerUrl ? { url: sellerUrl } : {}) }
    : null;
  const location = page.locationText?.trim() ?? '';
  if (!location) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace item location could not be parsed.' };

  const state = extractItemState(page.stateText ?? '');
  const candidate = {
    id: input.id,
    url: input.url,
    title: (page.title ?? '').trim().slice(0, 256),
    price: priceResult.status === 'ok' ? priceResult.price : null,
    currency,
    location: location.slice(0, 256),
    posted_at: parsePostedAt(page.timeDateTime),
    updated_at: null,
    description: (page.descriptionText ?? '').replace(/\bSee\s+(?:more|less)\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 280),
    images: page.imageUrls.slice(0, 6),
    seller,
    state
  };
  const parsed = listingSchema.safeParse(candidate);
  if (!parsed.success) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace item could not be parsed.' };
  return { kind: 'listing', listing: parsed.data };
}

function extractItemState(text: string): Listing['state'] {
  for (const line of text.split('\n')) {
    const indicator = line.trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '').toLowerCase();
    if (indicator === 'sold') return 'sold';
    if (indicator === 'pending') return 'pending';
    if (indicator === 'removed' || indicator === 'no longer available') return 'removed';
  }
  return 'active';
}

export function interpretMarketplacePage(input: ParseMarketplaceInput): MarketplaceSearchOutcome {
  const kind = classifyMarketplacePage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook Marketplace requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook Marketplace requires login.' };
  if (kind === 'rate_limited') return { kind: 'error', code: 'RATE_LIMITED', message: 'Facebook Marketplace temporarily limited this search.' };
  if (kind === 'unknown') return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace search page layout was not recognised.' };
  if (kind === 'no_results') return { kind: 'empty', stats: emptyStats(input.page.cards.length) };

  const result = parseMarketplacePage(input);
  const parseFailureSkips = (result.stats.skipReasons.missing_item_id ?? 0)
    + (result.stats.skipReasons.missing_title ?? 0)
    + (result.stats.skipReasons.malformed_price ?? 0)
    + (result.stats.skipReasons.invalid_listing ?? 0);
  if (result.listings.length === 0 && parseFailureSkips > 0) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace results were present but could not be parsed.' };
  }
  if (result.listings.length > 0) return { kind: 'listings', ...result };
  return { kind: 'empty', stats: result.stats };
}

function emptyStats(cardsSeen: number): MarketplaceParseStats {
  return { cardsSeen, structurallyValid: 0, duplicates: 0, skipReasons: {}, ambiguousPrices: 0, cardPriceTokens: [] };
}
