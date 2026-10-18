# Oura Ring MCP Server (read-only)

[![npm](https://img.shields.io/npm/v/@royreznik/oura-ring-mcp)](https://www.npmjs.com/package/@royreznik/oura-ring-mcp)
[![CI](https://github.com/royreznik/oura-ring-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/royreznik/oura-ring-mcp/actions/workflows/ci.yml)
[![oura-ring-mcp MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/royreznik/oura-ring-mcp/badges/score.svg)](https://glama.ai/mcp/servers/royreznik/oura-ring-mcp)
[![M8ven Score](https://m8ven.ai/badge/mcp/royreznik-oura-ring-mcp-1tyadq?v=ff911170a2bef8d07a409e94b229c6f3)](https://m8ven.ai/mcp/royreznik-oura-ring-mcp-1tyadq?s=readme)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Read-only](https://img.shields.io/badge/data_access-read--only-2ea44f)](SECURITY.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Ask Claude, Cursor, VS Code or any [MCP](https://modelcontextprotocol.io) client about your [Oura Ring](https://ouraring.com) readiness, sleep, HRV, activity, stress and heart rate, without giving it any way to change your data.

> *"How did I sleep last night, and why is my readiness only 64?"*
> *"Compare my HRV and lowest heart rate over the last 30 days."*
> *"Show me last night's sleep stages and heart-rate curve."*
> *"Does my readiness drop after days I tagged alcohol?"*

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=oura&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkByb3lyZXpuaWsvb3VyYS1yaW5nLW1jcCJdfQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=oura&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40royreznik%2Foura-ring-mcp%22%5D%7D)

(Run the one-time [`auth` step](#2-connect-your-oura-account) before or after installing.)

## Why this server

- **Read-only, enforced.** Oura's API has no write endpoints for your data, and this client goes further: it can only send `GET`, refuses any URL outside `/v2/usercollection/`, never touches the webhook API, and every tool carries `readOnlyHint: true`. Tests fail the build otherwise.
- **Answers whole questions in one call.** `get_daily_overview` returns a day's readiness, sleep, naps, activity, stress, resilience, SpO2, workouts and tags together. `get_trends` returns a day table plus averages and readiness zones over up to 90 days.
- **Model-friendly output.** Compact JSON with hours, minutes, km and local times instead of seconds and meters; hypnograms as stage segments; heart rate aggregated into buckets. Pass `raw: true` for Oura's original objects.
- **Degrades gracefully.** If you untick a data type on Oura's consent page, combined tools list it under `unavailable` instead of failing.
- **Your tokens stay on your machine.** Your own Oura API application, OAuth with PKCE, a `0600` token file, and safe handling of Oura's single-use refresh tokens. No third-party servers, no telemetry.
- **Try it without an account.** `OURA_SANDBOX=1` serves Oura's public sample data.

## Quick start

You need **Node.js 20.11+** and an Oura account. (Oura retired personal access tokens in December 2025, so OAuth is the only way in.)

### 1. Create an Oura API application (2 minutes)

1. Open [cloud.ouraring.com/oauth/applications](https://cloud.ouraring.com/oauth/applications) and create a new application.
2. Set the **Redirect URI** to `http://localhost:8787/callback`.
3. Copy the **Client ID** and **Client Secret**.

Applications work for up to 10 users without Oura's approval, which is plenty for personal use.

### 2. Connect your Oura account

```bash
npx -y @royreznik/oura-ring-mcp auth
```

Paste your Client ID and Client Secret when asked (the secret isn't echoed). Your browser opens Oura's consent page; leave every data type ticked and approve. Tokens are saved to `~/.config/oura-ring-mcp/tokens.json` and refreshed automatically from then on.

(For scripts, set `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` instead of answering the prompts.)

### 3. Add it to your MCP client

<details open>
<summary><b>Claude Code</b></summary>

**As a plugin** (adds the server plus an `/oura:auth` skill that walks you through connecting):

```text
/plugin marketplace add royreznik/oura-ring-mcp
/plugin install oura@oura-ring-mcp
```

**Or just the MCP server:**

```bash
claude mcp add oura --scope user -- npx -y @royreznik/oura-ring-mcp
```
</details>

<details>
<summary><b>Claude Desktop, Cursor, Windsurf</b></summary>

Add to the client's MCP config (Claude Desktop: Settings → Developer → Edit Config; Cursor: `~/.cursor/mcp.json`; Windsurf: `~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "oura": {
      "command": "npx",
      "args": ["-y", "@royreznik/oura-ring-mcp"]
    }
  }
}
```

For Claude Desktop you can also install the `.mcpb` bundle from the [latest release](https://github.com/royreznik/oura-ring-mcp/releases/latest).
</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

`.vscode/mcp.json` (or your user `mcp.json`):

```json
{
  "servers": {
    "oura": { "type": "stdio", "command": "npx", "args": ["-y", "@royreznik/oura-ring-mcp"] }
  }
}
```
</details>

<details>
<summary><b>OpenAI Codex CLI</b></summary>

`~/.codex/config.toml`:

```toml
[mcp_servers.oura]
command = "npx"
args = ["-y", "@royreznik/oura-ring-mcp"]
```
</details>

<details>
<summary><b>Docker</b></summary>

Run `auth` on the host first, then mount the token directory:

```bash
docker build -t oura-ring-mcp https://github.com/royreznik/oura-ring-mcp.git
docker run -i --rm -v ~/.config/oura-ring-mcp:/home/node/.config/oura-ring-mcp oura-ring-mcp
```
</details>

Then ask: *"Give me my Oura overview for today."*

### Try it without an account

```bash
claude mcp add oura-sandbox --env OURA_SANDBOX=1 -- npx -y @royreznik/oura-ring-mcp
```

Sandbox mode serves Oura's public sample data. No auth step, no personal data.

## Tools

| Tool | What it returns |
| --- | --- |
| `get_daily_overview` | One day: readiness, sleep score and main sleep, naps, activity, stress, resilience, SpO2, cardiovascular age, VO2 max, bedtime guidance, workouts, sessions, tags (defaults to the latest scored day) |
| `get_trends` | Day-by-day table plus avg/min/max for readiness, sleep and activity scores, sleep stages, HRV, lowest HR, temperature, steps, calories and stress, over 1-90 days |
| `get_profile` | Age, height, weight, sex, email; ring model, size, color, firmware; battery level |
| `list_daily_readiness` | Readiness scores, contributors, temperature deviation |
| `list_daily_sleep` | Sleep scores and contributors |
| `list_sleep_periods` / `get_sleep_period` | Nights and naps: stages, latency, efficiency, HR, HRV, breathing; one night's hypnogram and HR/HRV curves |
| `list_daily_activity` | Activity score, steps, calories, activity minutes, sedentary time |
| `list_workouts` | Activity, intensity, duration, calories, distance (filterable by activity) |
| `list_sessions` | Meditation/breathing/relaxation sessions with mood, HR and HRV |
| `list_daily_health` | Stress, resilience, SpO2 and breathing disturbance, cardiovascular age, VO2 max, bedtime window, joined by day |
| `list_tags` | Tags and notes from the Oura app (alcohol, caffeine, sickness, custom...) |
| `list_rest_mode_periods` | Rest Mode periods and their symptom tags |
| `get_heart_rate` | Heart-rate time series aggregated to 5min/15min/hour/day (or raw), with per-source stats; up to 30 days per call |

List tools accept `start` / `end` (`YYYY-MM-DD`, inclusive), a `days` shortcut and `next_token`. See the **[tool reference](docs/tools.md)** for details.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OURA_CLIENT_ID` | from token file | Your app's client ID (`auth` asks if unset) |
| `OURA_CLIENT_SECRET` | from token file | Your app's client secret (`auth` asks, without echoing, if unset) |
| `OURA_REDIRECT_URI` | `http://localhost:8787/callback` | Must exactly match a redirect URI registered on your app |
| `OURA_TOKEN_PATH` | `~/.config/oura-ring-mcp/tokens.json` | Where credentials are stored. Must be absolute (`~/` is expanded). Honours `XDG_CONFIG_HOME`. |
| `OURA_SANDBOX` | unset | `1` serves Oura's public sample data instead of your account |

```text
oura-ring-mcp            Start the MCP server on stdio (what your MCP client runs)
oura-ring-mcp auth       Connect your Oura account (opens your browser)
oura-ring-mcp status     Check the stored connection
oura-ring-mcp logout     Delete the locally stored tokens
oura-ring-mcp --version
```

"Today" is computed in your computer's timezone, which should match the timezone your Oura app uses.

## Privacy and security

- oura-ring-mcp talks only to `api.ouraring.com` (plus your browser visiting `cloud.ouraring.com` during `auth`). No telemetry, no intermediary server.
- Tokens and your client secret live in one file only your user can read (`0600`). They are never logged or returned by tools.
- **Your MCP client sends tool results to its language model.** Health data you ask about is shared with that model provider under its terms.
- To disconnect, run `oura-ring-mcp logout`. To revoke access completely, delete the application at [cloud.ouraring.com/oauth/applications](https://cloud.ouraring.com/oauth/applications) or revoke it in your Oura account.

Details: [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md).

## How authentication works

- OAuth 2 authorization-code flow with PKCE (S256) and a random `state`, captured by a loopback-only callback server.
- Oura refresh tokens are single-use. oura-ring-mcp refreshes shortly before expiry (and on a 401), one refresh at a time, under a lock file so several clients on one machine (e.g. Claude Desktop and Claude Code) never refresh at once, and writes new tokens atomically. If a write fails, the new tokens stay in memory so a full disk can't log you out.
- Rate limits (429, honouring `Retry-After`), server errors, timeouts (30s) and network errors are retried with backoff. Cancelling a request in your client stops its Oura calls.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Oura shows a redirect URI error | The app's redirect URI must match `OURA_REDIRECT_URI` exactly, including `http://`, port and `/callback`. |
| `Port 8787 is in use` | Register another URI on your app (e.g. `http://localhost:9876/callback`) and run `auth` with `OURA_REDIRECT_URI` set to it. |
| `Not connected to Oura` | Run `auth`. If your client runs as a different user or `HOME`, set `OURA_TOKEN_PATH` in the client config. |
| `Oura rejected the refresh token` | Run `auth` again (app secret rotated, access revoked, or the token file was copied to another machine). |
| A data type appears under `unavailable` (403) | It was unticked on Oura's consent page, or needs an active Oura membership. Run `auth` again and allow it. |
| `426` error | Update the Oura app on your phone and open it so it syncs. |
| Today's data is missing | Oura only has data after the ring syncs through the Oura app. Open the app, then ask again. |

```bash
npx -y @royreznik/oura-ring-mcp status
```

## Development

```bash
npm install
npm test                 # unit, MCP integration, end-to-end and packaging tests (no network)
npm run smoke:sandbox    # every tool against Oura's live sandbox API
npm run smoke:live       # every tool against your account (after auth); prints only counts
npm run inspect          # MCP Inspector
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The one hard rule: oura-ring-mcp stays read-only.

## Credits and legal

Architecture, auth and test approach are adapted from [whoop-mcp](https://github.com/oryanomer1/whoop-mcp) by Oryan Omer (MIT).

MIT © Roy Reznik. Unofficial project, not affiliated with or endorsed by Oura Health Oy. "Oura" is a trademark of Oura Health Oy. Nothing here is medical advice.
