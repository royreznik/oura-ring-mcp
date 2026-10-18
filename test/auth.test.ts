import { chmodSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotAuthenticatedError, TokenManager, TokenStore, type StoredCredentials } from "../src/auth.js";
import { tokenPath } from "../src/config.js";
import { fakeFetch, json } from "./helpers.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");

function creds(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    client_id: "client",
    client_secret: "secret",
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: NOW + 3_600_000,
    scope: "daily heartrate",
    ...overrides,
  };
}

const refreshed = (n: number) =>
  json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, scope: "daily", token_type: "bearer" });

let store: TokenStore;

beforeEach(() => {
  store = new TokenStore(join(mkdtempSync(join(tmpdir(), "oura-ring-mcp-")), "nested", "tokens.json"));
});

describe("TokenStore", () => {
  it("round-trips credentials in an owner-only file", async () => {
    expect(await store.load()).toBeNull();
    await store.save(creds());

    expect(await store.load()).toEqual(creds());
    if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(await store.clear()).toBe(true);
    expect(await store.clear()).toBe(false);
  });

  it("leaves no temporary files behind", async () => {
    await store.save(creds());
    await store.save(creds({ access_token: "access-2" }));
    expect(readdirSync(dirname(store.path))).toEqual(["tokens.json"]);
  });

  it("reports a corrupt file without echoing its contents", async () => {
    await store.save(creds());
    writeFileSync(store.path, '{"refresh_token": "SECRET-123');
    const err = (await store.load().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(NotAuthenticatedError);
    expect(err.message).toContain("corrupt");
    expect(err.message).not.toContain("SECRET");
  });
});

describe("TokenStore.withLock", () => {
  it("never removes a lock it no longer owns", async () => {
    const lock = `${store.path}.lock`;
    await store.withLock(async () => {
      // Simulate another process that broke this lock and took its own.
      writeFileSync(lock, "someone-else");
    });
    expect(statSync(lock).isFile()).toBe(true);
  });

  it("runs unlocked, and says so, where no lock file can be created", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // permissions differ
    await store.save(creds());
    chmodSync(dirname(store.path), 0o500);
    try {
      const onUnlockable = vi.fn();
      expect(await store.withLock(async () => "ran", onUnlockable)).toBe("ran");
      expect(onUnlockable).toHaveBeenCalledWith(expect.objectContaining({ code: "EACCES" }));
    } finally {
      chmodSync(dirname(store.path), 0o700);
    }
  });
});

describe("tokenPath", () => {
  it("defaults to the XDG config directory", () => {
    expect(tokenPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "oura-ring-mcp", "tokens.json"));
    expect(tokenPath({})).toBe(join(homedir(), ".config", "oura-ring-mcp", "tokens.json"));
  });

  it("accepts absolute or ~ paths and rejects relative ones", () => {
    const abs = join(tmpdir(), "t.json");
    expect(tokenPath({ OURA_TOKEN_PATH: abs })).toBe(abs);
    expect(tokenPath({ OURA_TOKEN_PATH: "~/w/t.json" })).toBe(join(homedir(), "w", "t.json"));
    expect(() => tokenPath({ OURA_TOKEN_PATH: "tokens.json" })).toThrow(/absolute/);
  });
});

/** A fake Oura token endpoint that rotates refresh tokens and rejects reused ones, like the real one. */
function rotatingTokenEndpoint(opts: { delayMs?: number } = {}) {
  let valid = "refresh-1";
  let n = 1;
  const used: string[] = [];
  const fetch = fakeFetch(async (_url, init) => {
    const presented = new URLSearchParams(String(init?.body)).get("refresh_token")!;
    used.push(presented);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (presented !== valid) return json({ error: "invalid_grant" }, 400);
    n++;
    valid = `refresh-${n}`;
    return refreshed(n);
  });
  return { fetch, used };
}

describe("TokenManager", () => {
  it("returns the stored token while it is fresh", async () => {
    await store.save(creds());
    const fetch = fakeFetch(() => refreshed(2));
    const manager = new TokenManager(store, { fetch, now: () => NOW });

    expect(await manager.getAccessToken()).toBe("access-1");
    expect(fetch.calls).toHaveLength(0);
  });

  it("refreshes an expired token and persists the rotated refresh token", async () => {
    await store.save(creds({ expires_at: NOW + 30_000 }));
    const fetch = fakeFetch(() => refreshed(2));
    const manager = new TokenManager(store, { fetch, now: () => NOW });

    expect(await manager.getAccessToken()).toBe("access-2");

    const { url, init } = fetch.calls[0];
    expect(url.toString()).toBe("https://api.ouraring.com/oauth/token");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client",
      client_secret: "secret",
    });
    expect(await store.load()).toMatchObject({
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_at: NOW + 3_600_000,
    });
  });

  it("issues a single refresh for concurrent callers", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const fetch = fakeFetch(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return refreshed(2);
    });
    const manager = new TokenManager(store, { fetch, now: () => NOW });

    const tokens = await Promise.all([manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()]);

    expect(tokens).toEqual(["access-2", "access-2", "access-2"]);
    expect(fetch.calls).toHaveLength(1);
  });

  it("forceRefresh only refreshes when the rejected token is still current", async () => {
    await store.save(creds());
    let n = 1;
    const fetch = fakeFetch(() => refreshed(++n));
    const manager = new TokenManager(store, { fetch, now: () => NOW });

    expect(await manager.forceRefresh("access-1")).toBe("access-2");
    expect(await manager.forceRefresh("access-1")).toBe("access-2");
    expect(fetch.calls).toHaveLength(1);
  });

  it("keeps the previous refresh token if Oura omits a new one", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const fetch = fakeFetch(() => json({ access_token: "access-2", expires_in: 3600 }));
    const manager = new TokenManager(store, { fetch, now: () => NOW });

    await manager.getAccessToken();

    expect((await store.load())?.refresh_token).toBe("refresh-1");
  });

  it("adopts tokens another process already rotated on disk", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const fetch = fakeFetch(() => refreshed(9));
    const manager = new TokenManager(store, { fetch, now: () => NOW });
    await expect(manager.forceRefresh("nope")).resolves.toBe("access-1"); // loads the expired creds into memory

    await store.save(creds({ access_token: "access-from-other-process", refresh_token: "refresh-x" }));

    expect(await manager.getAccessToken()).toBe("access-from-other-process");
    expect(fetch.calls).toHaveLength(0);
  });

  it("prefers client credentials passed via options", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const fetch = fakeFetch(() => refreshed(2));
    const manager = new TokenManager(store, { fetch, now: () => NOW, clientId: "env-id", clientSecret: "env-secret" });

    await manager.getAccessToken();

    const body = new URLSearchParams(String(fetch.calls[0].init?.body));
    expect(body.get("client_id")).toBe("env-id");
    expect(body.get("client_secret")).toBe("env-secret");
  });

  it("asks the user to re-authenticate when Oura rejects the refresh token", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const fetch = fakeFetch(() => json({ error: "invalid_grant" }, 400));
    const manager = new TokenManager(store, { fetch, now: () => NOW });

    const err = await manager.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotAuthenticatedError);
    expect((err as Error).message).toContain("oura-ring-mcp auth");
  });

  it("keeps a rotated refresh token in memory if saving it fails", async () => {
    class FlakyStore extends TokenStore {
      failures = 0;
      override async save(c: StoredCredentials) {
        if (this.failures-- > 0) throw new Error("EROFS: read-only file system");
        return super.save(c);
      }
    }
    const flaky = new FlakyStore(store.path);
    await flaky.save(creds({ expires_at: NOW - 1 }));
    flaky.failures = 1;
    const { fetch, used } = rotatingTokenEndpoint();
    const log = vi.fn();
    let now = NOW;
    const manager = new TokenManager(flaky, { fetch, now: () => now, log });

    expect(await manager.getAccessToken()).toBe("access-2");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not save refreshed tokens"));

    now += 2 * 3_600_000; // access-2 expires; the next refresh must use refresh-2 from memory
    expect(await manager.getAccessToken()).toBe("access-3");
    expect(used).toEqual(["refresh-1", "refresh-2"]);
    expect(await flaky.load()).toMatchObject({ refresh_token: "refresh-3" });
  });

  it("doesn't overwrite credentials that `auth` saved while it was holding unsaved tokens", async () => {
    class FlakyStore extends TokenStore {
      failures = 0;
      override async save(c: StoredCredentials) {
        if (this.failures-- > 0) throw new Error("EBUSY: resource busy");
        return super.save(c);
      }
    }
    const flaky = new FlakyStore(store.path);
    await flaky.save(creds({ expires_at: NOW - 1 }));
    flaky.failures = 1;
    const manager = new TokenManager(flaky, { fetch: rotatingTokenEndpoint().fetch, now: () => NOW, log: () => {} });
    expect(await manager.getAccessToken()).toBe("access-2"); // refreshed, but not saved

    // The user re-runs `oura-ring-mcp auth` with a different app.
    await store.save(creds({ client_id: "new-app", access_token: "access-new", refresh_token: "refresh-new" }));

    expect(await manager.getAccessToken()).toBe("access-new");
    expect(await store.load()).toMatchObject({ client_id: "new-app", refresh_token: "refresh-new" });
  });

  it("refreshes even where the token directory is read-only, keeping tokens in memory", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // permissions differ
    await store.save(creds({ expires_at: NOW - 1 }));
    chmodSync(dirname(store.path), 0o500);
    try {
      const log = vi.fn();
      const manager = new TokenManager(store, { fetch: rotatingTokenEndpoint().fetch, now: () => NOW, log });
      expect(await manager.getAccessToken()).toBe("access-2");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("refreshing without it"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("could not save refreshed tokens"));
    } finally {
      chmodSync(dirname(store.path), 0o700);
    }
  });


  it("serializes refreshes across processes sharing one token file", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const { fetch, used } = rotatingTokenEndpoint({ delayMs: 30 });
    const processA = new TokenManager(new TokenStore(store.path), { fetch, now: () => NOW });
    const processB = new TokenManager(new TokenStore(store.path), { fetch, now: () => NOW });

    const tokens = await Promise.all([processA.getAccessToken(), processB.getAccessToken()]);

    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(used).toEqual(["refresh-1"]);
  });

  it("adopts newer tokens when it loses a refresh race to a process without the lock", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const fetch = fakeFetch(async () => {
      // Another process rotated refresh-1 a moment earlier and saved the result.
      await store.save(creds({ access_token: "access-other", refresh_token: "refresh-other" }));
      return json({ error: "invalid_grant" }, 400);
    });
    const manager = new TokenManager(store, { fetch, now: () => NOW });

    expect(await manager.getAccessToken()).toBe("access-other");
  });

  it("breaks a stale lock left behind by a crashed process", async () => {
    await store.save(creds({ expires_at: NOW - 1 }));
    const lock = `${store.path}.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const manager = new TokenManager(store, { fetch: rotatingTokenEndpoint().fetch, now: () => NOW });

    expect(await manager.getAccessToken()).toBe("access-2");
    expect(() => statSync(lock)).toThrow();
  });

  it("explains how to connect when there are no tokens", async () => {
    const manager = new TokenManager(store, { now: () => NOW });
    await expect(manager.getAccessToken()).rejects.toThrow(/oura-ring-mcp auth/);
  });
});
