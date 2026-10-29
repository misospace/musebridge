import { normalizeRetryAfterHeader } from './retry-after.js';
import { resolveCredentialBaseUrl } from './credential-url.js';

export interface TicketmasterClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface TicketmasterSearchOptions {
  city?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
}

export class TicketmasterHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    super(`Ticketmaster API returned HTTP ${status}`);
    this.name = 'TicketmasterHttpError';
  }
}

export class TicketmasterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string;

  constructor(options: TicketmasterClientOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) throw new TypeError('apiKey must not be empty');
    // The Discovery API key travels as a query parameter; destination restriction
    // shared with the other provider clients (see credential-url.ts).
    this.baseUrl = resolveCredentialBaseUrl(
      options.baseUrl ?? 'https://app.ticketmaster.com',
      ['app.ticketmaster.com'],
      'baseUrl must be https://app.ticketmaster.com or a loopback test address'
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
  }

  async searchEvents(query: string, options: TicketmasterSearchOptions, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ apikey: this.apiKey, keyword: query, size: String(options.limit) });
    if (options.city !== undefined) params.set('city', options.city);
    // The user-supplied bounds are calendar dates (YYYY-MM-DD), not instants. Mapping them to
    // `startDateTime`/`endDateTime` would treat local-midnight in the event's timezone as a UTC
    // instant and silently drop late-evening shows on `end_date` while admitting events from the
    // previous local day. Discovery's documented `localStartDateTime` / `localEndDateTime`
    // parameters filter by the event's own local clock, which is the semantics a calendar date
    // implies. The bare `T00:00:00` / `T23:59:59` (no `Z`) is intentional — the provider reads
    // the value as the local event time.
    if (options.startDate !== undefined) params.set('localStartDateTime', `${options.startDate}T00:00:00`);
    if (options.endDate !== undefined) params.set('localEndDateTime', `${options.endDate}T23:59:59`);
    return this.apiRequest(`/discovery/v2/events.json?${params}`, signal);
  }

  async getEvent(id: string, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ apikey: this.apiKey });
    return this.apiRequest(`/discovery/v2/events/${encodeURIComponent(id)}.json?${params}`, signal);
  }

  private async apiRequest(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' }, signal
    });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
}

async function responseError(response: Response): Promise<TicketmasterHttpError> {
  // Normalization (blank/negative/nonnumeric/out-of-range → no hint, fraction truncated) is
  // shared with the other provider clients in retry-after.ts.
  return new TicketmasterHttpError(response.status, normalizeRetryAfterHeader(response.headers.get('retry-after')));
}
