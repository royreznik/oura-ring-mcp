#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sandboxTokens, TokenManager, TokenStore } from "./auth.js";
import { OuraClient } from "./client.js";
import { DEFAULT_REDIRECT_URI, OURA_APPS_URL, sandboxEnabled, tokenPath } from "./config.js";
import { login } from "./login.js";
import { promptLine, promptSecret } from "./prompt.js";
import { createServer } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `oura-ring-mcp ${version}: read-only MCP server for your Oura Ring data

Usage:
  oura-ring-mcp           Start the MCP server on stdio (what your MCP client runs)
  oura-ring-mcp auth      Connect your Oura account (opens your browser)
  oura-ring-mcp status    Check the stored connection
  oura-ring-mcp logout    Delete the locally stored tokens

Environment:
  OURA_CLIENT_ID       Client ID of your app at ${OURA_APPS_URL} (auth asks if unset)
  OURA_CLIENT_SECRET   Client secret of that app (auth asks, without echoing, if unset)
  OURA_REDIRECT_URI    Redirect URI registered on the app (default: ${DEFAULT_REDIRECT_URI})
  OURA_TOKEN_PATH      Token file (default: ~/.config/oura-ring-mcp/tokens.json)
  OURA_SANDBOX=1       Serve Oura's public sample data instead of your account (no auth needed)
`;

const env = process.env;

function tokenManager(store: TokenStore): TokenManager {
  return new TokenManager(store, {
    clientId: env.OURA_CLIENT_ID || undefined,
    clientSecret: env.OURA_CLIENT_SECRET || undefined,
  });
}

async function serve(store: TokenStore): Promise<void> {
  const sandbox = sandboxEnabled();
  const client = sandbox ? new OuraClient(sandboxTokens, { sandbox }) : new OuraClient(tokenManager(store));
  const server = createServer(client, version);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol, so diagnostics go to stderr.
  console.error(`oura-ring-mcp ${version} running on stdio (${sandbox ? "sandbox data" : `tokens: ${store.path}`})`);
}

async function auth(store: TokenStore): Promise<void> {
  const redirectUri = env.OURA_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  // Re-running auth can reuse the client credentials saved last time.
  const saved = await store.load().catch(() => null);
  let clientId = env.OURA_CLIENT_ID || saved?.client_id;
  let clientSecret = env.OURA_CLIENT_SECRET || saved?.client_secret;
  if ((!clientId || !clientSecret) && process.stdin.isTTY) {
    console.log(
      `You need an Oura API application: ${OURA_APPS_URL}\n` +
        `Add the redirect URI ${redirectUri} to it.\n`,
    );
    clientId ||= await promptLine("Client ID: ");
    clientSecret ||= await promptSecret("Client Secret (hidden): ");
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      `Set OURA_CLIENT_ID and OURA_CLIENT_SECRET first. Create an app at ${OURA_APPS_URL} ` +
        `with redirect URI ${redirectUri}. See the README for details.`,
    );
  }
  const creds = await login({
    clientId,
    clientSecret,
    redirectUri,
    store,
    log: (m) => console.log(m),
  });
  console.log(`Connected${await whoAmI(store)}. Tokens saved to ${store.path}`);
  if (creds.scope) console.log(`Granted data types: ${creds.scope}`);
}

/** " as <email>" when the email scope was granted; empty otherwise. */
async function whoAmI(store: TokenStore): Promise<string> {
  try {
    const info = await new OuraClient(tokenManager(store)).getPersonalInfo();
    return info.email ? ` as ${info.email}` : "";
  } catch {
    return "";
  }
}

async function status(store: TokenStore): Promise<void> {
  const creds = await store.load();
  if (!creds) {
    console.log(`Not connected (no tokens at ${store.path}). Run: oura-ring-mcp auth`);
    process.exitCode = 1;
    return;
  }
  console.log(`Token file:   ${store.path}`);
  console.log(`Scopes:       ${creds.scope ?? "(not reported by Oura)"}`);
  console.log(`Access token: expires ${new Date(creds.expires_at).toISOString()} (refreshed automatically)`);
  // Any read proves the connection.
  const rings = await new OuraClient(tokenManager(store)).listRingConfigurations();
  console.log(`Connected${await whoAmI(store)} (${rings.length} ring${rings.length === 1 ? "" : "s"})`);
}

async function logout(store: TokenStore): Promise<void> {
  const removed = await store.clear();
  console.log(removed ? `Deleted ${store.path}.` : `No tokens stored at ${store.path}.`);
}

async function main(argv: string[]): Promise<void> {
  const store = new TokenStore(tokenPath());
  const command = argv[0] ?? "serve";
  switch (command) {
    case "serve":
      return serve(store);
    case "auth":
    case "login":
      return auth(store);
    case "status":
      return status(store);
    case "logout":
      return logout(store);
    case "-v":
    case "--version":
      console.log(version);
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
