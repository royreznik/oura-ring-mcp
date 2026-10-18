import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const OURA_API_BASE = "https://api.ouraring.com";
export const OURA_AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const OURA_APPS_URL = "https://cloud.ouraring.com/oauth/applications";

/**
 * Every Oura scope is a read scope: the Oura API has no endpoints that change user data.
 * Users can untick individual scopes on Oura's consent page; tools then report that
 * data type as unavailable instead of failing.
 */
export const OURA_SCOPES = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "workout",
  "tag",
  "session",
  "spo2",
  "stress",
  "heart_health",
  "ring_configuration",
] as const;

export const DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";

/** Per-request timeout for Oura API and token calls. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Upper bound on pages followed per collection call, so a huge range can't run away. */
export const MAX_PAGES = 50;

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.OURA_TOKEN_PATH;
  if (custom) {
    const expanded = custom.startsWith("~/") ? join(homedir(), custom.slice(2)) : custom;
    // A relative path would resolve differently for the CLI and for each MCP client's working directory.
    if (!isAbsolute(expanded)) throw new Error(`OURA_TOKEN_PATH must be an absolute path (got "${custom}").`);
    return expanded;
  }
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "oura-ring-mcp", "tokens.json");
}

/** Sandbox mode serves Oura's public sample data, so the server can be tried without an account. */
export function sandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes"].includes((env.OURA_SANDBOX ?? "").toLowerCase());
}
