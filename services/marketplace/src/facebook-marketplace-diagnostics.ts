import type { ExtractedMarketplacePage } from './facebook-marketplace-extract.js';
import type { MarketplaceParseStats } from './facebook-marketplace-parse.js';
import { classifyMarketplacePage } from './facebook-marketplace-parse.js';

/** Explicit projection: never spread browser data into logs. */
export function marketplaceSearchDiagnostic(input: {
  requestedUrl: string;
  first: ExtractedMarketplacePage;
  final: ExtractedMarketplacePage;
  navigationMs: number;
  settleMs: number;
  settleTimeoutMs: number;
  samples: number;
}) {
  const requested = new URL(input.requestedUrl);
  let finalUrl: URL | undefined;
  try { finalUrl = new URL(input.final.url); } catch { /* Malformed upstream location. */ }
  const final = input.final;
  const diagnostics = final.diagnostics;
  return {
    firstKind: classifyMarketplacePage(input.first),
    finalKind: classifyMarketplacePage(final),
    navigationMs: input.navigationMs,
    settleMs: input.settleMs,
    settleTimeoutMs: input.settleTimeoutMs,
    samples: input.samples,
    settleExpired: classifyMarketplacePage(final) === 'unknown' && input.settleMs >= input.settleTimeoutMs,
    sameOrigin: finalUrl?.origin === requested.origin,
    samePath: finalUrl?.pathname === requested.pathname,
    queryMatches: finalUrl?.searchParams.get('query') === requested.searchParams.get('query'),
    minPriceMatches: finalUrl?.searchParams.get('minPrice') === requested.searchParams.get('minPrice'),
    maxPriceMatches: finalUrl?.searchParams.get('maxPrice') === requested.searchParams.get('maxPrice'),
    loginRoute: /^\/login(?:\/|\.php|$)/.test(finalUrl?.pathname ?? ''),
    checkpointRoute: /^\/checkpoint(?:\/|$)/.test(finalUrl?.pathname ?? ''),
    hasLoginForm: final.signals.hasLoginForm,
    hasCheckpoint: final.signals.hasCheckpoint,
    hasCaptcha: final.signals.hasCaptcha,
    // The gate actually applied (#168): unobserved visibility keeps the conservative captcha
    // verdict, so the log states what the classifier used rather than dropping the distinction.
    captchaVisible: final.signals.captchaVisible ?? true,
    hasRateLimitNotice: final.signals.hasRateLimitNotice,
    hasNoResultsNotice: final.signals.hasNoResultsNotice,
    cards: final.cards.length,
    documentReadyComplete: diagnostics?.documentReadyComplete ?? false,
    hasMainLandmark: diagnostics?.hasMainLandmark ?? false,
    itemAnchorCount: diagnostics?.itemAnchorCount ?? 0,
    pageTextChars: diagnostics?.pageTextChars ?? 0,
    pageTextTruncated: diagnostics?.pageTextTruncated ?? false,
    unfilteredTextTruncated: diagnostics?.unfilteredTextTruncated ?? false,
    unfilteredHasNoResultsNotice: diagnostics?.unfilteredHasNoResultsNotice ?? false,
    visibleBodyHasNoResults: diagnostics?.visibleBodyHasNoResults ?? false,
    visibleMainHasNoResults: diagnostics?.visibleMainHasNoResults ?? false,
    englishLocale: diagnostics?.englishLocale ?? false,
    radius500Matched: diagnostics?.radius500Matched ?? false
  };
}

/**
 * Explicit projection of the search parse stats (#182): counts only, never card text,
 * prices, or any provider content. `cardPriceTokens` carries one count per card that
 * reached price parsing, so deployed evidence can show multi-price cards without
 * recording what those prices were.
 */
export function marketplaceSearchParseDiagnostic(stats: MarketplaceParseStats) {
  return {
    cardsSeen: stats.cardsSeen,
    structurallyValid: stats.structurallyValid,
    duplicates: stats.duplicates,
    ambiguousPrices: stats.ambiguousPrices,
    cardPriceTokens: [...stats.cardPriceTokens],
    skipReasons: { ...stats.skipReasons }
  };
}
