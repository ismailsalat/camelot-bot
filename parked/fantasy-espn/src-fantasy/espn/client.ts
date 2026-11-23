import { log } from '../../logger.js';

/**
 * Read-only ESPN Fantasy client.
 *
 * ESPN's fantasy API is unofficial and undocumented, so everything here is
 * defensive: narrow surface, typed failures, caching, and no assumption that
 * any field exists. Nothing in this file ever logs or returns credentials.
 */

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba';

export type EspnErrorKind =
  | 'no-credentials'
  | 'auth'
  | 'not-found'
  | 'rate-limited'
  | 'espn-down'
  | 'network'
  | 'bad-response';

export class EspnError extends Error {
  constructor(
    readonly kind: EspnErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EspnError';
  }

  /** Short, non-technical, safe to show in Discord. */
  get friendly(): string {
    switch (this.kind) {
      case 'no-credentials':
        return 'ESPN login not set up yet.';
      case 'auth':
        return "ESPN rejected the login — the cookies have probably expired.";
      case 'not-found':
        return "Couldn't find that league on ESPN.";
      case 'rate-limited':
        return 'ESPN is rate limiting us. Try again in a minute.';
      case 'espn-down':
        return 'ESPN is having a moment. Try again shortly.';
      case 'bad-response':
        return "ESPN sent something I couldn't read.";
      default:
        return "Couldn't reach ESPN.";
    }
  }
}

export interface EspnCredentials {
  espnS2: string;
  swid: string;
}

/** Credentials come from the environment only — never from the database. */
export function credentialsFromEnv(): EspnCredentials | null {
  const espnS2 = process.env.ESPN_S2?.trim();
  const rawSwid = process.env.ESPN_SWID?.trim();
  if (!espnS2 || !rawSwid) return null;
  // ESPN wants SWID wrapped in braces; accept it either way.
  const swid = rawSwid.startsWith('{') ? rawSwid : `{${rawSwid}}`;
  return { espnS2, swid };
}

export function hasCredentials(): boolean {
  return credentialsFromEnv() !== null;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

export interface EspnClientOptions {
  seasonId: number;
  leagueId: string;
  credentials?: EspnCredentials | null;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Cache lifetime in ms. */
  ttlMs?: number;
  timeoutMs?: number;
}

export class EspnClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: EspnClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  get seasonId(): number {
    return this.options.seasonId;
  }

  get leagueId(): string {
    return this.options.leagueId;
  }

  private url(views: string[], extra?: Record<string, string>): string {
    const url = new URL(`${BASE}/seasons/${this.options.seasonId}/segments/0/leagues/${this.options.leagueId}`);
    for (const view of views) url.searchParams.append('view', view);
    for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      // ESPN rejects requests without a browser-ish agent.
      'user-agent': 'Mozilla/5.0 (compatible; CamelotBot/1.0)',
    };
    const credentials = this.options.credentials ?? credentialsFromEnv();
    if (credentials) {
      headers.cookie = `espn_s2=${credentials.espnS2}; SWID=${credentials.swid}`;
    }
    return headers;
  }

  /** Clear everything, or just the entries whose key contains `prefix`. */
  invalidate(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.includes(prefix)) this.cache.delete(key);
    }
  }

  async get<T = unknown>(views: string[], extra?: Record<string, string>, options?: { fresh?: boolean }): Promise<T> {
    const url = this.url(views, extra);
    const key = url;

    if (!options?.fresh) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    }

    // Collapse concurrent identical requests — several people hitting the
    // dashboard at once should cost ESPN one call, not six.
    const existing = this.inFlight.get(key);
    if (existing) return (await existing) as T;

    const request = this.request(url)
      .then((value) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return (await request) as T;
  }

  private async request(url: string): Promise<unknown> {
    const credentials = this.options.credentials ?? credentialsFromEnv();
    if (!credentials) {
      throw new EspnError('no-credentials', 'ESPN credentials are not configured.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: this.headers(),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      // The URL is safe to log; the cookie header is never included.
      log.debug(`ESPN request failed: ${message}`);
      throw new EspnError('network', 'Could not reach ESPN.');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new EspnError('auth', 'ESPN refused the request.', response.status);
    }
    if (response.status === 404) {
      throw new EspnError('not-found', 'League not found.', response.status);
    }
    if (response.status === 429) {
      throw new EspnError('rate-limited', 'Rate limited by ESPN.', response.status);
    }
    if (response.status >= 500) {
      throw new EspnError('espn-down', 'ESPN returned a server error.', response.status);
    }
    if (!response.ok) {
      throw new EspnError('bad-response', `Unexpected status ${response.status}.`, response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new EspnError('bad-response', 'ESPN did not return JSON.');
    }
  }
}

/** A one-call check used by `/fantasy status`. Never throws. */
export async function probe(client: EspnClient): Promise<
  { ok: true; leagueName: string } | { ok: false; kind: EspnErrorKind; message: string }
> {
  try {
    const raw = (await client.get<{ settings?: { name?: string } }>(['mSettings'], undefined, { fresh: true })) ?? {};
    return { ok: true, leagueName: raw.settings?.name ?? 'Unnamed league' };
  } catch (error) {
    if (error instanceof EspnError) return { ok: false, kind: error.kind, message: error.friendly };
    return { ok: false, kind: 'network', message: "Couldn't reach ESPN." };
  }
}
