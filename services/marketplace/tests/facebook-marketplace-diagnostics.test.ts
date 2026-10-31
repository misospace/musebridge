import { describe, expect, it } from 'vitest';
import { marketplaceSearchDiagnostic, marketplaceSearchParseDiagnostic } from '../src/facebook-marketplace-diagnostics.js';
import type { ExtractedMarketplacePage } from '../src/facebook-marketplace-extract.js';

describe('Marketplace search diagnostic projection', () => {
  it('logs only flags, counts, timing and known classifications', () => {
    const page: ExtractedMarketplacePage = {
      url: 'https://www.facebook.com/checkpoint/private-id?query=secret&token=secret',
      signals: {hasLoginForm: false, hasCheckpoint: true, hasCaptcha: false, hasRateLimitNotice: false, hasNoResultsNotice: false},
      cards: [],
      diagnostics: {documentReadyComplete: true, hasMainLandmark: false, itemAnchorCount: 0, pageTextChars: 100, pageTextTruncated: false, unfilteredTextTruncated: false, unfilteredHasNoResultsNotice: false, visibleBodyHasNoResults: false, visibleMainHasNoResults: false, englishLocale: true, radius500Matched: false}
    };
    const logged = marketplaceSearchDiagnostic({requestedUrl: 'https://www.facebook.com/marketplace/calgary/search/?query=private-query', first: page, final: page, navigationMs: 10, settleMs: 0, settleTimeoutMs: 3000, samples: 1});
    expect(logged).toMatchObject({firstKind: 'checkpoint', finalKind: 'checkpoint', sameOrigin: true, samePath: false, queryMatches: false, checkpointRoute: true});
    expect(Object.values(logged).every(value => typeof value === 'boolean' || typeof value === 'number' || value === 'checkpoint')).toBe(true);
    expect(JSON.stringify(logged)).not.toMatch(/secret|private|facebook|https/);
  });
});

describe('Marketplace search parse diagnostic projection (#182)', () => {
  it('logs only counts and structural skip reasons', () => {
    const logged = marketplaceSearchParseDiagnostic({
      cardsSeen: 3,
      structurallyValid: 2,
      duplicates: 1,
      skipReasons: { duplicate: 1 },
      ambiguousPrices: 1,
      cardPriceTokens: [2, 1, 2]
    });
    expect(logged).toEqual({
      cardsSeen: 3,
      structurallyValid: 2,
      duplicates: 1,
      ambiguousPrices: 1,
      cardPriceTokens: [2, 1, 2],
      skipReasons: { duplicate: 1 }
    });
    expect(JSON.stringify(logged)).not.toMatch(/http|[$]|\d{5,}/);
  });
});
