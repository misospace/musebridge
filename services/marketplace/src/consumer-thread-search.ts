export type ConsumerSearchField = 'participants' | 'preview';

export interface ConsumerSearchableThread {
  thread_id: string;
  participants?: string[];
  preview?: string;
}

export interface ConsumerSearchOutcome<T extends ConsumerSearchableThread = ConsumerSearchableThread> {
  matches: Array<T & { matched_on: ConsumerSearchField[] }>;
  /** The allowlisted fields that carried a value on at least one observed thread — the fields the
   *  query was actually matched against, reported so a caller always knows what an empty result
   *  means (#79 contract). */
  searchableFields: ConsumerSearchField[];
}

const SEARCHABLE_FIELDS: readonly ConsumerSearchField[] = ['participants', 'preview'];

/**
 * The matching normalization: Unicode NFKC, case folding, and internal-whitespace collapse on
 * both the query and the candidate values. It is deliberately the only normalization — no regex,
 * no fuzzy matching, no stemming, and nothing is inferred from position, order, or timestamps.
 */
export function normalizeConsumerText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function fieldValues(thread: ConsumerSearchableThread, field: ConsumerSearchField): string[] {
  if (field === 'participants') return thread.participants ?? [];
  const preview = thread.preview;
  return preview === undefined ? [] : [preview];
}

/**
 * Strict in-memory matching over a verified observation (#79): the query matches a thread when it
 * is a case-insensitive substring of one of the thread's allowlisted field values. Matching never
 * leaves the process — the query is caller intent, is never logged, and is never typed into the
 * provider; the search layer adds no request of its own over the single listing load.
 */
export function searchConsumerThreads<T extends ConsumerSearchableThread>(input: {
  threads: readonly T[];
  query: string;
}): ConsumerSearchOutcome<T> {
  const needle = normalizeConsumerText(input.query);
  const searchableFields = SEARCHABLE_FIELDS.filter((field) =>
    input.threads.some((thread) => fieldValues(thread, field).some((value) => value.length > 0))
  );
  if (needle.length === 0) return { matches: [], searchableFields };
  const matches: ConsumerSearchOutcome<T>['matches'] = [];
  for (const thread of input.threads) {
    const matchedOn = SEARCHABLE_FIELDS.filter((field) =>
      searchableFields.includes(field)
      && fieldValues(thread, field).some((value) => normalizeConsumerText(value).includes(needle))
    );
    if (matchedOn.length > 0) matches.push({ ...thread, matched_on: matchedOn });
  }
  return { matches, searchableFields };
}
