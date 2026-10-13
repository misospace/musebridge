# Issue #80 search validation

## Observed on 2026-10-13

- Current deployed `marketplace_search` for the deliberate fixture `Jetson AGX`,
  Calgary, limit 5 returns `UPSTREAM_ERROR` with unknown search layout.
- Native authenticated Chrome, at `/marketplace/calgary/search/` with that fixture,
  exposes an explicit no-listings notice, 500-kilometer radius, Calgary,
  zero item links in the accessibility tree, and no login/CAPTCHA marker.
- These are different sessions. Matching request location does not establish that
  the deployed profile has matching stored radius or locale.

## Reproduced code defect

The old page-level text walker includes script/style/hidden text before its
20,000-character cutoff. A delayed notice embedded in JavaScript is incorrectly
classified as empty before it renders. A large script before a visible notice can
also hide that notice beyond the cutoff. Synthetic browser fixtures reproduce
both mechanisms. The correction excludes non-rendered text while retaining
card exclusion and the existing anchor/card strategy.

This establishes a parsing defect, but its contribution to the live failure
remains unverified until the corrected service's diagnostics are collected.

## Controlled deployed smoke

Run `services/marketplace/scripts/marketplace-search-smoke.mjs` with Node inside
the deployed container. It connects only to that container's loopback MCP
endpoint and emits elapsed time, success, result count and allowlisted error
code. Add `--expect-empty` only when the live page confirms authentic emptiness;
available listings can change between runs.

Inspect only the static `Facebook Marketplace search diagnostics:` records.
They contain first/final classifications, sample counts, navigation and settle
timings, redirect/query/filter equality flags, auth flags, anchor/card counts,
bounded text length/truncation flags, visible empty-state flags, English-locale
and 500-kilometer-radius flags. No provider strings, URLs, queries, item IDs,
HTML, cookies, tokens or extracted listings enter those records.

Interpretation:

- `unfilteredTextTruncated=true`, `unfilteredHasNoResultsNotice=false`, and
  `hasNoResultsNotice=true` demonstrate loss through the original cutoff.
- An unknown first sample followed by a recognizable final sample measures
  render delay within the existing bounded settle window.
- Unknown at timeout remains `UPSTREAM_ERROR`; it is never empty success.
- Auth/challenge flags take precedence over an empty notice.
- Redirect/equality and locale/radius flags can expose session variation.
  Unknown or unmatched settings require further observation, not guessed values.

## Completion gate

Do not close #80 until the reviewed change runs in the deployed service and a
controlled smoke records the structural cause, authentic zero results (if the
fixture remains empty), and no sensitive browser data in diagnostic output.
