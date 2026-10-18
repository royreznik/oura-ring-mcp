# Oura plugin for Claude Code (read-only)

Ask Claude about your Oura Ring readiness, sleep, HRV, activity, heart rate and multi-day trends. The plugin starts the [oura-ring-mcp](https://github.com/royreznik/oura-ring-mcp) server (`@royreznik/oura-ring-mcp` on npm) and adds an `/oura:auth` skill for the one-time sign-in. It is read-only by design: it can only send GET requests to Oura's data API and can never change your data.

## Install

```text
/plugin marketplace add royreznik/oura-ring-mcp
/plugin install oura@oura-ring-mcp
```

## Connect your Oura account (once)

1. Create an Oura API application at https://cloud.ouraring.com/oauth/applications with the redirect URI `http://localhost:8787/callback`.
2. In a terminal, run `npx -y @royreznik/oura-ring-mcp auth`, paste the Client ID and Client Secret, and approve access in your browser.

Or run `/oura:auth` and Claude will walk you through it. Then ask: *"How did I sleep last night?"*

## Tools

`get_daily_overview`, `get_trends`, `get_profile`, `list_daily_readiness`, `list_daily_sleep`, `list_sleep_periods`, `get_sleep_period`, `list_daily_activity`, `list_workouts`, `list_sessions`, `list_daily_health`, `list_tags`, `list_rest_mode_periods`, `get_heart_rate`. See the [tool reference](https://github.com/royreznik/oura-ring-mcp/blob/main/docs/tools.md).

Unofficial; not affiliated with Oura Health Oy. Not medical advice. MIT licensed.
