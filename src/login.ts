import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { requestToken, toStoredCredentials, type StoredCredentials, type TokenStore } from "./auth.js";
import { OURA_AUTH_URL, OURA_SCOPES } from "./config.js";
import { promptLine } from "./prompt.js";
import { sanitize } from "./util.js";

export interface LoginOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  store: TokenStore;
  fetch?: typeof fetch;
  openBrowser?: boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Receives the authorization URL; tests use it to play the browser. */
  onAuthorizeUrl?: (url: string) => void;
  /** Asks for the redirected URL when the redirect URI isn't a local callback. */
  prompt?: (question: string) => Promise<string>;
}

const base64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function generateState(): string {
  return base64url(randomBytes(24));
}

/** PKCE (RFC 7636), which Oura recommends: a stolen authorization code is useless without the verifier. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48)); // 64 characters, within the 43-128 limit
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(OURA_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OURA_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Runs the OAuth authorization-code flow (with PKCE) and saves the resulting tokens. */
export async function login(opts: LoginOptions): Promise<StoredCredentials> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const redirect = new URL(opts.redirectUri);
  const state = generateState();
  const pkce = generatePkce();
  const authorizeUrl = buildAuthorizeUrl(opts.clientId, opts.redirectUri, state, pkce.challenge);

  let code: string;
  if (isLoopback(redirect)) {
    const pending = waitForCallback(redirect, state, opts.timeoutMs ?? 5 * 60_000);
    await pending.listening;
    log(`Opening your browser to authorize Oura access. If it doesn't open, visit:\n\n  ${authorizeUrl}\n`);
    opts.onAuthorizeUrl?.(authorizeUrl);
    if (opts.openBrowser !== false) openInBrowser(authorizeUrl);
    code = await pending.code;
  } else {
    // A non-local redirect can't be captured here, so the user pastes the URL they land on.
    log(`Open this URL, approve access, then copy the full URL you are redirected to:\n\n  ${authorizeUrl}\n`);
    opts.onAuthorizeUrl?.(authorizeUrl);
    if (opts.openBrowser !== false) openInBrowser(authorizeUrl);
    code = codeFromRedirect(await (opts.prompt ?? promptLine)("Paste the redirected URL: "), state);
  }

  const token = await requestToken(
    {
      grant_type: "authorization_code",
      code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      code_verifier: pkce.verifier,
    },
    opts.fetch,
  );
  const creds = toStoredCredentials(token, { clientId: opts.clientId, clientSecret: opts.clientSecret }, Date.now());
  // Under the token lock, so a running server's refresh can't overwrite the new grant.
  await opts.store.withLock(() => opts.store.save(creds));
  return creds;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export class StateMismatchError extends Error {
  constructor() {
    super("OAuth state mismatch. Start `oura-ring-mcp auth` again and use the newest browser tab.");
    this.name = "StateMismatchError";
  }
}

export function codeFromRedirect(redirectedUrl: string, expectedState: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(redirectedUrl.trim()).searchParams;
  } catch {
    throw new Error("That doesn't look like a URL. Copy the full address from the browser's address bar.");
  }
  // Check state before anything else, so a forged request can't even report an error.
  if (params.get("state") !== expectedState) throw new StateMismatchError();
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    throw new Error(`Oura authorization failed: ${sanitize(error, 80)}${description ? ` (${sanitize(description)})` : ""}`);
  }
  const code = params.get("code");
  if (!code) throw new Error("The redirect URL has no authorization code.");
  return code;
}

function waitForCallback(
  redirect: URL,
  state: string,
  timeoutMs: number,
): { listening: Promise<void>; code: Promise<string> } {
  const port = Number(redirect.port || 80);
  // Bind to loopback only. "localhost" may resolve to IPv4 or IPv6, so listen on both.
  const hosts = redirect.hostname === "localhost" ? ["127.0.0.1", "::1"] : [redirect.hostname.replace(/^\[|\]$/g, "")];
  const servers: Server[] = [];
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    clearTimeout(timer);
    for (const s of servers) s.close();
  };

  const code = new Promise<string>((resolve, reject) => {
    const reply = (res: ServerResponse, status: number, title: string, message: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(page(title, message));
    };
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", redirect);
      } catch {
        reply(res, 400, "Bad request", "Malformed request.");
        return;
      }
      if (req.method !== "GET" || url.pathname !== redirect.pathname) {
        res.writeHead(404, { Connection: "close" }).end();
        return;
      }
      try {
        const result = codeFromRedirect(url.toString(), state);
        reply(res, 200, "Oura connected", "You can close this tab and return to your terminal.");
        close();
        resolve(result);
      } catch (err) {
        if (err instanceof StateMismatchError) {
          // Stale tab or a forged request: refuse it, but keep waiting for the real callback.
          reply(
            res,
            400,
            "Link expired",
            "This authorization link doesn't belong to the running `oura-ring-mcp auth`. Use the newest tab it opened.",
          );
          return;
        }
        reply(res, 400, "Oura authorization failed", (err as Error).message);
        close();
        reject(err);
      }
    };
    servers.push(...hosts.map(() => createServer(handler)));
    timer = setTimeout(() => {
      close();
      reject(new Error("Timed out waiting for the Oura authorization callback."));
    }, timeoutMs);
  });

  const listening = Promise.allSettled(
    servers.map(
      (server, i) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, hosts[i], () => resolve());
        }),
    ),
  ).then((results) => {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason as NodeJS.ErrnoException);
    // Tolerate a missing address family (e.g. IPv6 disabled), but not a port taken by another program.
    const fatal = errors.find((e) => e.code !== "EADDRNOTAVAIL" && e.code !== "EAFNOSUPPORT");
    if (fatal || errors.length === servers.length) {
      close();
      const reason = fatal ?? errors[0];
      throw new Error(
        reason.code === "EADDRINUSE"
          ? `Port ${port} is in use. Free it or set OURA_REDIRECT_URI to another port (and register it on your Oura app).`
          : `Could not start the callback server on ${redirect.host}: ${reason.message}`,
      );
    }
  });
  // The caller stops awaiting `code` if listening fails; avoid an unhandled rejection.
  code.catch(() => {});
  return { listening, code };
}

function page(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>${esc(title)}</h1><p>${esc(message)}</p></body>`;
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is already printed; opening the browser is best-effort.
  }
}
