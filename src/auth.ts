import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { OURA_TOKEN_URL, REQUEST_TIMEOUT_MS } from "./config.js";
import { sanitize, sleep } from "./util.js";

export interface StoredCredentials {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export class NotAuthenticatedError extends Error {
  constructor(message = "Not connected to Oura. Run `oura-ring-mcp auth` to connect your account.") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

export class TokenRequestError extends Error {
  constructor(
    readonly status: number,
    /** The OAuth `error` code, e.g. `invalid_grant`. */
    readonly code?: string,
    detail?: string,
  ) {
    super(`Oura token request failed (${status})${detail ? `: ${detail}` : "."}`);
    this.name = "TokenRequestError";
  }
}

/** A live lock holder refreshes the lock file's mtime this often... */
const LOCK_HEARTBEAT_MS = 5_000;
/** ...so a lock this old belongs to a crashed process and can be reclaimed. */
const LOCK_STALE_MS = 20_000;
/** Longer than LOCK_STALE_MS, so waiters always outlast a crashed holder's lock. */
const LOCK_WAIT_MS = 45_000;
/** Lock-file errors that mean "can't lock here" (e.g. a read-only directory), not "someone else has it". */
const UNLOCKABLE = new Set(["EACCES", "EPERM", "EROFS"]);

function isCredentials(value: unknown): value is StoredCredentials {
  const c = value as StoredCredentials;
  return (
    typeof c === "object" &&
    c !== null &&
    typeof c.access_token === "string" &&
    typeof c.refresh_token === "string" &&
    typeof c.client_id === "string" &&
    typeof c.client_secret === "string" &&
    typeof c.expires_at === "number"
  );
}

/** Persists credentials as an owner-only (0600) JSON file. */
export class TokenStore {
  constructor(readonly path: string) {}

  async load(): Promise<StoredCredentials | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON.parse's message: it quotes fragments of the file, which holds secrets.
      parsed = undefined;
    }
    if (!isCredentials(parsed)) {
      throw new NotAuthenticatedError(`The token file ${this.path} is corrupt. Run \`oura-ring-mcp auth\` to reconnect.`);
    }
    return parsed;
  }

  async save(creds: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Exclusive create under a random name never writes into a pre-planted file or symlink.
    // Write-then-rename means a crash can't leave a truncated file and lose the single-use refresh token.
    const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(creds, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async clear(): Promise<boolean> {
    try {
      await rm(this.path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Runs `fn` holding a lock file next to the token file, so processes sharing
   * the file (e.g. Claude Desktop and Claude Code) never refresh at the same time.
   * If no lock can be created at all (e.g. a read-only directory), runs `fn` unlocked
   * and reports why through `onUnlockable`.
   */
  async withLock<T>(fn: () => Promise<T>, onUnlockable?: (err: Error) => void): Promise<T> {
    const lock = `${this.path}.lock`;
    const nonce = randomBytes(8).toString("hex");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const file = await open(lock, "wx", 0o600);
        try {
          await file.writeFile(nonce);
        } finally {
          await file.close();
        }
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (UNLOCKABLE.has(code)) {
          onUnlockable?.(err as Error);
          return fn();
        }
        if (code !== "EEXIST") throw err;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          // The holder stopped heartbeating, so it crashed. Remove that lock, unless a
          // competing waiter has already replaced it with a fresh one.
          const staleNonce = await readFile(lock, "utf8").catch(() => null);
          const again = await stat(lock).catch(() => null);
          if (again?.mtimeMs === info.mtimeMs) await removeLock(lock, staleNonce);
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error("Another oura-ring-mcp process is busy refreshing the Oura tokens. Try again in a moment.");
        }
        await sleep(50 + Math.random() * 100);
      }
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lock, now, now).catch(() => {});
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await removeLock(lock, nonce);
    }
  }
}

/** Deletes the lock only while it still holds `nonce`, so nobody removes a lock they don't own. */
async function removeLock(lock: string, nonce: string | null): Promise<void> {
  try {
    if (nonce === null || (await readFile(lock, "utf8")) !== nonce) return;
    // Retries cover Windows, where antivirus can briefly hold the file (EBUSY/EPERM).
    await rm(lock, { force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Already gone, or still busy: a lock that stops heartbeating is reclaimed as stale.
  }
}

function parseTokenError(body: string): { code?: string; detail?: string } {
  try {
    const { error, error_description } = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (typeof error !== "string") return {};
    const code = sanitize(error, 60);
    return { code, detail: typeof error_description === "string" ? `${code} (${sanitize(error_description)})` : code };
  } catch {
    return {};
  }
}

/** POSTs to Oura's OAuth token endpoint. This is the only non-GET request the server ever makes. */
export async function requestToken(
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl(OURA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    // Never re-send the client secret or refresh token to a redirect target.
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const { code, detail } = parseTokenError(text);
    throw new TokenRequestError(res.status, code, detail);
  }
  let token: TokenResponse | undefined;
  try {
    token = JSON.parse(text) as TokenResponse;
  } catch {
    token = undefined;
  }
  if (typeof token?.access_token !== "string" || typeof token.expires_in !== "number") {
    throw new Error("Oura returned an unexpected token response.");
  }
  return token;
}

export function toStoredCredentials(
  token: TokenResponse,
  client: { clientId: string; clientSecret: string },
  now: number,
  previous?: { refresh_token: string; scope?: string },
): StoredCredentials {
  const refreshToken = token.refresh_token ?? previous?.refresh_token;
  if (!refreshToken) {
    throw new Error("Oura did not return a refresh token. Run `oura-ring-mcp auth` again.");
  }
  return {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    access_token: token.access_token,
    refresh_token: refreshToken,
    expires_at: now + token.expires_in * 1000,
    scope: token.scope ?? previous?.scope,
  };
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  forceRefresh(staleToken: string): Promise<string>;
}

/** Oura's sandbox accepts any bearer string, so no account or tokens are involved. */
export const sandboxTokens: AccessTokenProvider = {
  getAccessToken: async () => "sandbox",
  forceRefresh: async () => "sandbox",
};

export interface TokenManagerOptions {
  /** Overrides the client ID saved by `oura-ring-mcp auth`. */
  clientId?: string;
  /** Overrides the client secret saved by `oura-ring-mcp auth`. */
  clientSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Diagnostics sink; defaults to stderr (stdout carries the MCP protocol). */
  log?: (message: string) => void;
}

/** Refresh this long before the access token actually expires. */
const EXPIRY_SKEW_MS = 60_000;

export class TokenManager implements AccessTokenProvider {
  private creds: StoredCredentials | null = null;
  /** True when refreshed tokens couldn't be written: memory then holds the only valid refresh token. */
  private unsaved = false;
  /** While unsaved: the (already spent) refresh token the file still contains. */
  private unsavedFrom: string | null = null;
  private warnedUnlockable = false;
  private refreshing: Promise<StoredCredentials> | null = null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly store: TokenStore,
    private readonly opts: TokenManagerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  async getAccessToken(): Promise<string> {
    const creds = await this.current();
    if (!this.isFresh(creds)) return (await this.refresh()).access_token;
    if (this.unsaved) await this.retrySave();
    return this.creds!.access_token;
  }

  /**
   * Called after a 401. Refreshes only if `staleToken` is still current, so a
   * burst of concurrent 401s results in a single refresh.
   */
  async forceRefresh(staleToken: string): Promise<string> {
    const creds = await this.current();
    if (creds.access_token !== staleToken) return creds.access_token;
    return (await this.refresh()).access_token;
  }

  private async current(): Promise<StoredCredentials> {
    if (!this.creds) {
      this.creds = await this.store.load();
      if (!this.creds) throw new NotAuthenticatedError();
    }
    return this.creds;
  }

  private isFresh(creds: StoredCredentials): boolean {
    return creds.expires_at - EXPIRY_SKEW_MS > this.now();
  }

  private refresh(): Promise<StoredCredentials> {
    // Oura refresh tokens are single-use, so keep exactly one refresh in flight.
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private doRefresh(): Promise<StoredCredentials> {
    return this.store.withLock(async () => {
      // Re-read: `oura-ring-mcp auth` or another process may already have rotated the tokens.
      const latest = await this.store.load().catch((err: unknown) => {
        if (this.unsaved) return null;
        throw err;
      });
      if (this.unsaved && this.creds && (!latest || latest.refresh_token === this.unsavedFrom)) {
        // The file still holds tokens we already rotated; memory has the current ones.
        return this.refreshFrom(this.creds, true);
      }
      if (!latest) throw new NotAuthenticatedError();
      if (latest.access_token !== this.creds?.access_token && this.isFresh(latest)) return this.adopt(latest);
      return this.refreshFrom(latest, true);
    }, this.onUnlockable);
  }

  private readonly onUnlockable = (err: Error) => {
    if (this.warnedUnlockable) return;
    this.warnedUnlockable = true;
    this.log(`oura-ring-mcp: can't create a lock next to ${this.store.path} (${err.message}); refreshing without it.`);
  };

  private adopt(creds: StoredCredentials): StoredCredentials {
    this.creds = creds;
    this.unsaved = false;
    this.unsavedFrom = null;
    return creds;
  }

  private async refreshFrom(base: StoredCredentials, mayRetry: boolean): Promise<StoredCredentials> {
    const client = {
      clientId: this.opts.clientId ?? base.client_id,
      clientSecret: this.opts.clientSecret ?? base.client_secret,
    };
    let token: TokenResponse;
    try {
      token = await requestToken(
        {
          grant_type: "refresh_token",
          refresh_token: base.refresh_token,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        },
        this.opts.fetch,
      );
    } catch (err) {
      if (err instanceof TokenRequestError && (err.status === 400 || err.status === 401)) {
        // Lost a race against a process that doesn't hold our lock (e.g. an older version)?
        const latest = await this.store.load().catch(() => null);
        if (mayRetry && latest && latest.refresh_token !== base.refresh_token) {
          this.adopt(latest);
          return this.isFresh(latest) ? latest : this.refreshFrom(latest, false);
        }
        throw new NotAuthenticatedError(
          `Oura rejected the refresh token (${err.status}). Run \`oura-ring-mcp auth\` to reconnect your account.`,
        );
      }
      throw err;
    }

    // The old refresh token is spent now, so hold the new one in memory before anything can fail.
    const next = toStoredCredentials(token, client, this.now(), base);
    this.creds = next;
    try {
      await this.store.save(next);
      this.unsaved = false;
      this.unsavedFrom = null;
    } catch (err) {
      if (!this.unsaved) {
        this.log(
          `oura-ring-mcp: could not save refreshed tokens to ${this.store.path} (${(err as Error).message}). ` +
            "Keeping them in memory and retrying.",
        );
        this.unsaved = true;
        this.unsavedFrom = base.refresh_token;
      }
    }
    return next;
  }

  /** Retries writing in-memory tokens, unless the file has since been replaced (e.g. by `oura-ring-mcp auth`). */
  private async retrySave(): Promise<void> {
    try {
      await this.store.withLock(async () => {
        const onDisk = await this.store.load().catch(() => null);
        if (onDisk && onDisk.refresh_token !== this.unsavedFrom) {
          this.adopt(onDisk);
          return;
        }
        await this.store.save(this.creds!);
        this.adopt(this.creds!);
      }, this.onUnlockable);
    } catch {
      // Still unsaved; the next call tries again.
    }
  }
}
