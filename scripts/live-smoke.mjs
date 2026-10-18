// Live end-to-end check of every tool against the real Oura API (read-only).
//   npm run smoke:live      your own account; run `oura-ring-mcp auth` first
//   npm run smoke:sandbox   Oura's public sample data; no account needed
// Prints only tool names, pass/fail and record counts, never your health data.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sandboxTokens, TokenManager, TokenStore } from "../dist/auth.js";
import { OuraClient } from "../dist/client.js";
import { tokenPath } from "../dist/config.js";
import { createServer } from "../dist/server.js";

const sandbox = process.argv.includes("--sandbox");
let failed = 0;
let tokens = sandboxTokens;

if (!sandbox) {
  const store = new TokenStore(tokenPath());
  tokens = new TokenManager(store);
  // Force one refresh: proves single-use refresh-token rotation and that the new token is saved.
  const before = await store.load();
  if (!before) {
    console.error(`No tokens at ${store.path}. Run \`oura-ring-mcp auth\` first.`);
    process.exit(1);
  }
  await tokens.forceRefresh(await tokens.getAccessToken());
  const after = await store.load();
  const rotated = after.access_token !== before.access_token && after.refresh_token !== before.refresh_token;
  console.log(`${rotated ? "✓" : "✗"} token refresh: ${rotated ? "rotated and saved" : "tokens did not change"}`);
  console.log(`  granted scopes: ${after.scope ?? "(not reported)"}`);
  if (!rotated) failed++;
}

const server = createServer(new OuraClient(tokens, { sandbox }), "live-smoke");
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "live-smoke", version: "1.0.0" });
await client.connect(clientSide);

async function check(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (res.isError) {
    failed++;
    console.log(`✗ ${name}: ${text}`);
    return undefined;
  }
  const data = JSON.parse(text);
  const shape = Array.isArray(data.records)
    ? `${data.records.length} records`
    : Array.isArray(data.days)
      ? `${data.days.length} days`
      : Array.isArray(data.buckets)
        ? `${data.buckets.length} buckets`
        : `fields: ${Object.keys(data).join(", ")}`;
  const skipped = data.unavailable ? ` (unavailable: ${data.unavailable.join(", ")})` : "";
  console.log(`✓ ${name}: ${shape}${skipped}`);
  return data;
}

await check("get_profile");
await check("get_daily_overview");
await check("get_trends", { days: 14 });
await check("list_daily_readiness", { days: 7 });
await check("list_daily_sleep", { days: 7 });
const sleeps = await check("list_sleep_periods", { days: 7 });
await check("list_daily_activity", { days: 7 });
await check("list_workouts", { days: 30 });
await check("list_sessions", { days: 30 });
await check("list_daily_health", { days: 7 });
await check("list_tags", { days: 30 });
await check("list_rest_mode_periods", { days: 90 });
await check("get_heart_rate", { resolution: "hour" });
await check("get_heart_rate", { latest: true });

const sleepId = sleeps?.records[0]?.sleep_id;
// Oura's sandbox answers every single-document lookup with a 500, so only the real API can check this one.
if (sandbox) console.log("- get_sleep_period: skipped (not supported by Oura's sandbox)");
else if (sleepId) await check("get_sleep_period", { sleep_id: sleepId });
else console.log("- get_sleep_period: skipped (no sleep in the last 7 days)");

await client.close();
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll live checks passed.");
process.exitCode = failed ? 1 : 0;
