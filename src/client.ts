import type { AccessTokenProvider } from "./auth.js";
import { MAX_PAGES, OURA_API_BASE, REQUEST_TIMEOUT_MS } from "./config.js";
import type {
  DocumentType,
  DocumentTypes,
  Page,
  PersonalInfo,
  RingConfiguration,
  TimeSeriesType,
  TimeSeriesTypes,
} from "./types.js";
import { addDays, errorName, sanitize, sleep } from "./util.js";

export class OuraApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(describeError(status, path, body));
    this.name = "OuraApiError";
  }
}

function describeError(status: number, path: string, body: string): string {
  switch (status) {
    case 401:
      return "Oura rejected the access token (401). Run `oura-ring-mcp auth` to reconnect your account.";
    case 403:
      return (
        `Oura denied access to ${path} (403). Either this data type wasn't ticked on Oura's consent page ` +
        "(run `oura-ring-mcp auth` again and allow it) or the Oura membership has expired."
      );
    case 404:
      return `Not found: ${path} (404).`;
    case 426:
      return "Oura needs a newer Oura app for this data (426). Update the Oura app on your phone and open it to sync.";
    case 429:
      return "Oura rate limit reached (429). Try again in a minute.";
    default:
      return `Oura API error ${status} on ${path}: ${sanitize(body, 300)}`;
  }
}

/** Inclusive calendar-day range (YYYY-MM-DD). */
export interface DayRange {
  start: string;
  end: string;
  nextToken?: string;
}

export interface TimeRange {
  /** ISO 8601 date-times. */
  start?: string;
  end?: string;
  latest?: boolean;
  nextToken?: string;
}

export interface CollectionResult<T> {
  data: T[];
  /** Pass back as `nextToken` to continue; null when there is nothing more. */
  next_token: string | null;
}

export interface OuraClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Serve Oura's public sandbox data (`/v2/sandbox/usercollection`) instead of the user's. */
  sandbox?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Cancels in-flight and pending requests, e.g. when the MCP client cancels a tool call. */
  signal?: AbortSignal;
}

type Query = Record<string, string | number | boolean | undefined>;

export class OuraClient {
  readonly sandbox: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly base: URL;
  private readonly collectionPath: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal?: AbortSignal;

  constructor(
    private readonly tokens: AccessTokenProvider,
    private readonly opts: OuraClientOptions = {},
  ) {
    this.sandbox = opts.sandbox ?? false;
    this.fetchImpl = opts.fetch ?? fetch;
    this.base = new URL(opts.baseUrl ?? OURA_API_BASE);
    this.collectionPath = this.sandbox ? "/v2/sandbox/usercollection" : "/v2/usercollection";
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxPages = opts.maxPages ?? MAX_PAGES;
    this.sleep = opts.sleep ?? sleep;
    this.signal = opts.signal;
  }

  /** A view of this client whose requests are cancelled by `signal`. */
  withSignal(signal: AbortSignal | undefined): OuraClient {
    return signal ? new OuraClient(this.tokens, { ...this.opts, signal }) : this;
  }

  getPersonalInfo(): Promise<PersonalInfo> {
    // The sandbox has no personal_info endpoint; this then fails with a 404.
    return this.get(`${this.collectionPath}/personal_info`);
  }

  async listRingConfigurations(): Promise<RingConfiguration[]> {
    return (await this.paginate<RingConfiguration>(`${this.collectionPath}/ring_configuration`, {})).data;
  }

  getDocument<K extends DocumentType>(type: K, id: string): Promise<DocumentTypes[K]> {
    return this.get(`${this.collectionPath}/${type}/${encodeURIComponent(id)}`);
  }

  /**
   * Documents whose day falls in the inclusive range. Oura's date filters differ per endpoint:
   * `end_date` is inclusive for some and exclusive for others, and `sleep` filters on the UTC
   * date of bedtime, which is the day before `day` for anyone who goes to bed before midnight.
   * So this asks for one extra day on each side and filters on `day` locally.
   */
  async documents<K extends DocumentType>(type: K, range: DayRange): Promise<CollectionResult<DocumentTypes[K]>> {
    const res = await this.paginate<DocumentTypes[K]>(`${this.collectionPath}/${type}`, {
      start_date: addDays(range.start, -1),
      end_date: addDays(range.end, 1),
      next_token: range.nextToken,
    });
    return { data: res.data.filter((doc) => inRange(doc, range)), next_token: res.next_token };
  }

  timeSeries<K extends TimeSeriesType>(type: K, range: TimeRange): Promise<CollectionResult<TimeSeriesTypes[K]>> {
    return this.paginate<TimeSeriesTypes[K]>(`${this.collectionPath}/${type}`, {
      start_datetime: range.start,
      end_datetime: range.end,
      latest: range.latest || undefined,
      next_token: range.nextToken,
    });
  }

  /** Follows `next_token` until the data runs out or the page budget is spent. */
  private async paginate<T>(path: string, query: Query): Promise<CollectionResult<T>> {
    const data: T[] = [];
    const seen = new Set<string>();
    let next = query.next_token as string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.get<Page<T>>(path, { ...query, next_token: next });
      data.push(...(res.data ?? []));
      next = res.next_token || undefined;
      if (next && seen.has(next)) next = undefined; // a repeated token would loop forever
      if (!next) break;
      seen.add(next);
    }
    return { data, next_token: next ?? null };
  }

  /**
   * The only HTTP primitive in this client. There is deliberately no
   * POST/PUT/PATCH/DELETE path, so the server cannot modify anything at Oura.
   */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(this.base.pathname.replace(/\/$/, "") + path, this.base);
    assertReadOnlyEndpoint(url, this.base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let token = await this.tokens.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      const canRetry = attempt < this.maxRetries;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "error",
          signal: this.requestSignal(),
        });
      } catch (err) {
        if (this.signal?.aborted) throw err;
        // Timeouts and network failures are worth another try; give up with a clear message.
        if (canRetry) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(
          errorName(err) === "TimeoutError"
            ? `Oura did not respond within ${this.timeoutMs / 1000}s (${path}).`
            : `Could not reach Oura (${path}): ${sanitize((err as Error).message)}`,
        );
      }
      if (res.status === 401 && !refreshed) {
        await res.body?.cancel();
        refreshed = true;
        token = await this.tokens.forceRefresh(token);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && canRetry) {
        await res.body?.cancel();
        await this.sleep(retryDelayMs(res, attempt));
        continue;
      }
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        if (this.signal?.aborted) throw err;
        if (canRetry) continue;
        throw new Error(`Oura stopped responding while sending ${path}. Try again.`);
      }
      if (!res.ok) throw new OuraApiError(res.status, path, text);
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Oura returned an unexpected (non-JSON) response for ${path}.`);
      }
    }
  }

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
  }
}

function inRange(doc: object, range: DayRange): boolean {
  const d = doc as { day?: string; start_day?: string; end_day?: string | null };
  if (typeof d.day === "string") return d.day >= range.start && d.day <= range.end;
  if (typeof d.start_day === "string") {
    // Periods (rest mode, tags with a duration) overlap the range if they started before it ended.
    return d.start_day <= range.end && (d.end_day ?? d.start_day) >= range.start;
  }
  return true;
}

/**
 * Defence in depth for the read-only guarantee: only the user-collection read endpoints on the
 * Oura API host. Webhook management, the only Oura API that can change state, is unreachable.
 */
function assertReadOnlyEndpoint(url: URL, base: URL): void {
  const root = base.pathname.replace(/\/$/, "");
  const allowed = [`${root}/v2/usercollection/`, `${root}/v2/sandbox/usercollection/`];
  // URL parsing has already resolved any "../" segments, so a prefix check is enough.
  if (url.origin !== base.origin || !allowed.some((prefix) => url.pathname.startsWith(prefix))) {
    throw new Error(`Refusing to request ${url.pathname}: not a read-only Oura endpoint.`);
  }
}

const MAX_RETRY_DELAY_MS = 30_000;

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function retryDelayMs(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1000 - Date.now();
    if (wait > 0) return Math.min(wait, MAX_RETRY_DELAY_MS);
  }
  return backoffMs(attempt);
}
