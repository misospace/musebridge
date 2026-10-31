import { describe, expect, it } from 'vitest';
import { normalizeConsumerText, searchConsumerThreads } from '../src/consumer-thread-search.js';
import type { ConsumerThread } from '../src/domain.js';

const thread = (overrides: Partial<ConsumerThread> & { thread_id: string }): ConsumerThread => ({
  route: 'plain',
  ...overrides
});

describe('consumer thread search matching', () => {
  it('normalizes with NFKC, case folding, and whitespace collapse', () => {
    expect(normalizeConsumerText('  Is   the\tBIKE  available? ')).toBe('is the bike available?');
    expect(normalizeConsumerText('ﬁxture')).toBe('fixture');
  });

  it('matches previews case-insensitively and names the matched field', () => {
    const threads = [thread({ thread_id: '1', preview: 'Is the bike still available?' })];
    const outcome = searchConsumerThreads({ threads, query: 'BIKE' });
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0]).toMatchObject({ thread_id: '1', matched_on: ['preview'] });
    expect(outcome.searchableFields).toEqual(['preview']);
  });

  it('matches participants when they carry values, and reports the searched field set honestly', () => {
    const threads = [
      thread({ thread_id: '1', participants: ['Synthetic Seller'], preview: 'Hello there' }),
      thread({ thread_id: '2', preview: 'No participants on this row' })
    ];
    const outcome = searchConsumerThreads({ threads, query: 'seller' });
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0]).toMatchObject({ thread_id: '1', matched_on: ['participants'] });
    expect(outcome.searchableFields).toEqual(['participants', 'preview']);

    // A participant query over a window where no row carried participants matches nothing, and
    // says so: the searchable field set is the honest scope of the emptiness.
    const noParticipants = searchConsumerThreads({ threads: [thread({ thread_id: '3', preview: 'Bike for sale' })], query: 'seller' });
    expect(noParticipants.matches).toHaveLength(0);
    expect(noParticipants.searchableFields).toEqual(['preview']);
  });

  it('collapses whitespace on both sides before matching', () => {
    const threads = [thread({ thread_id: '1', preview: 'Multi\n  word   query here' })];
    const outcome = searchConsumerThreads({ threads, query: 'multi word query' });
    expect(outcome.matches).toHaveLength(1);
  });

  it('reports no matches without claiming anything about threads outside the window', () => {
    const threads = [thread({ thread_id: '1', preview: 'Unrelated text' })];
    const outcome = searchConsumerThreads({ threads, query: 'kayak' });
    expect(outcome.matches).toHaveLength(0);
    // The window's fields are still the searched set; the caller learns what the emptiness means.
    expect(outcome.searchableFields).toEqual(['preview']);
  });

  it('never matches on identifiers, only on the allowlisted text fields', () => {
    const threads = [thread({ thread_id: '111111111111111', preview: 'Hello' })];
    const outcome = searchConsumerThreads({ threads, query: '111111111111111' });
    expect(outcome.matches).toHaveLength(0);
  });

  it('preserves observation order and records every field that matched', () => {
    const threads = [
      thread({ thread_id: '1', preview: 'Bike frame' }),
      thread({ thread_id: '2', preview: 'Bike helmet' }),
      thread({ thread_id: '3', preview: 'Car parts' })
    ];
    const outcome = searchConsumerThreads({ threads, query: 'bike' });
    expect(outcome.matches.map(({ thread_id }) => thread_id)).toEqual(['1', '2']);
    const bothFields = searchConsumerThreads({
      threads: [thread({ thread_id: '4', participants: ['Bike Seller'], preview: 'Bike frame' })],
      query: 'bike'
    });
    expect(bothFields.matches[0]?.matched_on).toEqual(['participants', 'preview']);
  });
});
