# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through [GitHub private vulnerability reporting](https://github.com/royreznik/oura-ring-mcp/security/advisories/new).

## Security model

oura-ring-mcp runs locally, on behalf of one person, against their own Oura account.

| Asset | Protection |
| --- | --- |
| Your Oura data | The API client can only send `GET`. At runtime it refuses any URL that isn't under `/v2/usercollection/` (or `/v2/sandbox/usercollection/`) on `api.ouraring.com`, so the webhook-subscription API, the only Oura API that changes state, is unreachable. A test fails the build if any other HTTP method appears outside the OAuth token exchange, or if the source mentions webhooks. Every tool is annotated `readOnlyHint: true`. |
| Access/refresh tokens and client secret | One JSON file (default `~/.config/oura-ring-mcp/tokens.json`), mode `0600`, in a directory created with mode `0700`. Writes go to a randomly named temp file opened with exclusive create, are fsynced, then atomically renamed. A lock file with an owner nonce and heartbeat serializes refreshes across processes, because Oura refresh tokens are single-use. If the file can't be written, refreshed tokens are kept in memory instead of being lost. Secrets are sent only to `api.ouraring.com` over HTTPS, token and API requests refuse redirects, and secrets are never logged or included in tool output. |
| OAuth login | Authorization-code flow with PKCE (S256) and a random 32-character `state`, checked before anything else in the callback. The callback server binds to loopback only, answers only `GET` on the callback path, ignores callbacks with the wrong `state` while it keeps waiting for the real one, HTML-escapes what it echoes, and shuts down after success or a 5-minute timeout. The client secret is entered at a hidden prompt. |
| MCP protocol stream | stdout carries only JSON-RPC. Diagnostics go to stderr. Text from Oura has control characters stripped before it reaches a terminal or error message. |
| Tool inputs | Validated with zod: dates are parsed strictly (`2026-02-30` is rejected), document ids are URL-encoded, ranges are capped (400 days for lists, 90 for trends, 30 for heart rate) and pagination is capped at 50 pages and stops on repeated tokens. Every request has a 30s timeout and is cancelled when the MCP client cancels the call. |

### What oura-ring-mcp cannot protect

- **Your MCP client and model provider.** Tool results go to the language model your client uses.
- **Your local account.** Anyone who can read files as your OS user can read the token file. `oura-ring-mcp logout` deletes it; deleting the application at [cloud.ouraring.com/oauth/applications](https://cloud.ouraring.com/oauth/applications) revokes access completely.
