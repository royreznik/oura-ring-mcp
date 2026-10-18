import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OuraApiError, OuraClient } from "../src/client.js";
import { fakeFetch, json, staticTokens } from "./helpers.js";

const noSleep = async (_ms: number) => {};

describe("OuraClient", () => {
  it("sends authenticated GET requests to the v2 user collection", async () => {
    const fetch = fakeFetch(() => json({ id: "u", email: "a@b.c" }));
    const client = new OuraClient(staticTokens, { fetch });

    const info = await client.getPersonalInfo();

    expect(info.email).toBe("a@b.c");
    expect(fetch.calls).toHaveLength(1);
    const { url, init } = fetch.calls[0];
    expect(url.toString()).toBe("https://api.ouraring.com/v2/usercollection/personal_info");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  it("asks for a day of margin on each side and keeps only documents inside the inclusive range", async () => {
    const fetch = fakeFetch(() =>
      json({
        data: [
          { id: "a", day: "2026-10-09" },
          { id: "b", day: "2026-10-10" },
          { id: "c", day: "2026-10-12" },
          { id: "d", day: "2026-10-13" },
        ],
        next_token: null,
      }),
    );
    const client = new OuraClient(staticTokens, { fetch });

    const res = await client.documents("daily_sleep", { start: "2026-10-10", end: "2026-10-12" });

    expect(res.data.map((d) => d.id)).toEqual(["b", "c"]);
    const { url } = fetch.calls[0];
    expect(url.pathname).toBe("/v2/usercollection/daily_sleep");
    expect(url.searchParams.get("start_date")).toBe("2026-10-09");
    expect(url.searchParams.get("end_date")).toBe("2026-10-13");
  });

  it("finds a night that started before midnight, though Oura filters sleep on bedtime in UTC", async () => {
    // Like the real API: start_date/end_date match the UTC date of bedtime_start, end exclusive.
    const night = { id: "n", day: "2026-10-13", bedtime_start: "2026-10-12T23:30:00+03:00" };
    const fetch = fakeFetch((url) => {
      const utcDay = new Date(night.bedtime_start).toISOString().slice(0, 10);
      const hit = utcDay >= url.searchParams.get("start_date")! && utcDay < url.searchParams.get("end_date")!;
      return json({ data: hit ? [night] : [], next_token: null });
    });
    const res = await new OuraClient(staticTokens, { fetch }).documents("sleep", { start: "2026-10-13", end: "2026-10-13" });
    expect(res.data.map((d) => d.id)).toEqual(["n"]);
  });

  it("keeps periods that overlap the range", async () => {
    const fetch = fakeFetch(() =>
      json({
        data: [
          { id: "before", start_day: "2026-09-01", end_day: "2026-09-05" },
          { id: "overlap", start_day: "2026-10-01", end_day: "2026-10-11" },
          { id: "ongoing", start_day: "2026-10-12", end_day: null },
        ],
        next_token: null,
      }),
    );
    const res = await new OuraClient(staticTokens, { fetch }).documents("rest_mode_period", {
      start: "2026-10-10",
      end: "2026-10-13",
    });
    expect(res.data.map((d) => d.id)).toEqual(["overlap", "ongoing"]);
  });

  it("follows next_token until the data runs out", async () => {
    const fetch = fakeFetch((url) => {
      const token = url.searchParams.get("next_token");
      return token
        ? json({ data: [{ id: "2", day: "2026-10-11" }], next_token: null })
        : json({ data: [{ id: "1", day: "2026-10-10" }], next_token: "page-2" });
    });
    const client = new OuraClient(staticTokens, { fetch });

    const res = await client.documents("workout", { start: "2026-10-10", end: "2026-10-11" });

    expect(res).toEqual({ data: [{ id: "1", day: "2026-10-10" }, { id: "2", day: "2026-10-11" }], next_token: null });
    expect(fetch.calls[1].url.searchParams.get("next_token")).toBe("page-2");
  });

  it("returns the next_token when the page budget runs out", async () => {
    let n = 0;
    const fetch = fakeFetch(() => json({ data: [{ id: String(n) }], next_token: `t${++n}` }));
    const client = new OuraClient(staticTokens, { fetch, maxPages: 3 });

    const res = await client.timeSeries("heartrate", { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z" });

    expect(fetch.calls).toHaveLength(3);
    expect(res.data).toHaveLength(3);
    expect(res.next_token).toBe("t3");
    expect(fetch.calls[0].url.searchParams.get("start_datetime")).toBe("2026-10-10T00:00:00Z");
    expect(fetch.calls[0].url.searchParams.get("end_datetime")).toBe("2026-10-11T00:00:00Z");
  });

  it("uses the sandbox collection in sandbox mode", async () => {
    const fetch = fakeFetch(() => json({ data: [], next_token: null }));
    const client = new OuraClient(staticTokens, { fetch, sandbox: true });

    await client.documents("daily_readiness", { start: "2026-10-10", end: "2026-10-10" });

    expect(fetch.calls[0].url.pathname).toBe("/v2/sandbox/usercollection/daily_readiness");
  });

  it("refreshes the token once on 401 and retries", async () => {
    const fetch = fakeFetch((_url, init) =>
      (init?.headers as Record<string, string>).Authorization === "Bearer token-2" ? json({ ok: true }) : json({}, 401),
    );
    const tokens = { ...staticTokens, forceRefresh: vi.fn(async () => "token-2") };
    const client = new OuraClient(tokens, { fetch });

    await expect(client.get("/v2/usercollection/sleep/1")).resolves.toEqual({ ok: true });
    expect(tokens.forceRefresh).toHaveBeenCalledWith("token-1");
  });

  it("gives up after a second 401", async () => {
    const fetch = fakeFetch(() => json({}, 401));
    const client = new OuraClient(staticTokens, { fetch });

    await expect(client.get("/v2/usercollection/sleep/1")).rejects.toMatchObject({ status: 401 });
    expect(fetch.calls).toHaveLength(2);
  });

  it("waits for Retry-After on 429 before retrying", async () => {
    let n = 0;
    const fetch = fakeFetch(() => (n++ === 0 ? json({}, 429, { "retry-after": "2" }) : json({ ok: true })));
    const sleep = vi.fn(noSleep);
    const client = new OuraClient(staticTokens, { fetch, sleep });

    await expect(client.get("/v2/usercollection/sleep")).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("retries server errors with backoff, then throws", async () => {
    const fetch = fakeFetch(() => new Response("boom", { status: 503 }));
    const sleep = vi.fn(noSleep);
    const client = new OuraClient(staticTokens, { fetch, sleep, maxRetries: 2 });

    const err = await client.get("/v2/usercollection/sleep").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OuraApiError);
    expect((err as OuraApiError).message).toContain("503");
    expect(fetch.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it("explains 403 and 426 in terms the user can act on", async () => {
    const forbidden = new OuraClient(staticTokens, { fetch: fakeFetch(() => json({}, 403)) });
    await expect(forbidden.get("/v2/usercollection/heartrate")).rejects.toThrow(/consent page.*membership/);
    const upgrade = new OuraClient(staticTokens, { fetch: fakeFetch(() => json({}, 426)) });
    await expect(upgrade.get("/v2/usercollection/sleep")).rejects.toThrow(/Update the Oura app/);
  });

  it("URL-encodes document ids", async () => {
    const fetch = fakeFetch(() => json({}));
    const client = new OuraClient(staticTokens, { fetch });

    await client.getDocument("sleep", "../../webhook/subscription");

    expect(fetch.calls[0].url.pathname).toBe("/v2/usercollection/sleep/..%2F..%2Fwebhook%2Fsubscription");
  });
});

describe("OuraClient robustness", () => {
  it("stops paginating when Oura repeats a next_token", async () => {
    const fetch = fakeFetch(() => json({ data: [{ id: 1 }], next_token: "same" }));
    const client = new OuraClient(staticTokens, { fetch });

    const res = await client.timeSeries("heartrate", {});

    expect(fetch.calls).toHaveLength(2);
    expect(res.next_token).toBeNull();
  });

  it("refuses anything but user-collection reads, even if asked directly", async () => {
    const fetch = fakeFetch(() => json({}));
    const client = new OuraClient(staticTokens, { fetch });

    await expect(client.get("/v2/webhook/subscription")).rejects.toThrow(/Refusing/);
    await expect(client.get("/oauth/token")).rejects.toThrow(/Refusing/);
    await expect(client.get("/v2/usercollection/../webhook/subscription")).rejects.toThrow(/Refusing/);
    await expect(client.get("//evil.example.com/v2/usercollection/sleep")).rejects.toThrow(/Refusing/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("explains non-JSON responses without echoing them", async () => {
    const fetch = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    const client = new OuraClient(staticTokens, { fetch });
    await expect(client.get("/v2/usercollection/sleep")).rejects.toThrow(/non-JSON/);
  });

  it("retries network failures, then reports them", async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new OuraClient(staticTokens, { fetch, sleep: noSleep, maxRetries: 2 });

    await expect(client.get("/v2/usercollection/sleep")).rejects.toThrow(/Could not reach Oura/);
    expect(fetch.calls).toHaveLength(3);
  });

  it("reports timeouts clearly", async () => {
    const fetch = fakeFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const client = new OuraClient(staticTokens, { fetch, sleep: noSleep, maxRetries: 0 });
    await expect(client.get("/v2/usercollection/sleep")).rejects.toThrow(/did not respond within 30s/);
  });

  it("stops immediately when the tool call is cancelled", async () => {
    const controller = new AbortController();
    const fetch = fakeFetch(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const client = new OuraClient(staticTokens, { fetch, sleep: noSleep }).withSignal(controller.signal);

    await expect(client.get("/v2/usercollection/sleep")).rejects.toThrow();
    expect(fetch.calls).toHaveLength(1);
  });

  it("strips control characters from upstream error bodies", async () => {
    const fetch = fakeFetch(() => new Response("bad\x1b[2Jthing", { status: 418 }));
    const client = new OuraClient(staticTokens, { fetch });
    const err = await client.get("/v2/usercollection/sleep").catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/\x1b/);
  });
});

describe("read-only guarantee", () => {
  it("never issues a non-GET request to the Oura data API", () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    for (const file of readdirSync(srcDir)) {
      const source = readFileSync(join(srcDir, file), "utf8");
      const methods = [...source.matchAll(/method:\s*"(\w+)"/g)].map((m) => m[1]);
      // auth.ts is the only place allowed to POST, and only to the OAuth token endpoint.
      const allowed = file === "auth.ts" ? ["POST"] : ["GET"];
      for (const method of methods) expect(allowed, `${file} uses ${method}`).toContain(method);
    }
    expect(readFileSync(join(srcDir, "auth.ts"), "utf8")).toMatch(/fetchImpl\(OURA_TOKEN_URL, \{\s*method: "POST"/);
  });

  it("never mentions the webhook API outside the endpoint guard", () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    for (const file of readdirSync(srcDir)) {
      const code = readFileSync(join(srcDir, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/webhook/i);
    }
  });
});
