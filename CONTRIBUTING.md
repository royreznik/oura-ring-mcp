# Contributing

Thanks for helping improve oura-ring-mcp! Bug reports, feature ideas and pull requests are all welcome.

## Ground rules

- **Read-only is a hard rule.** Contributions must not add any way to create, modify or delete Oura data. `test/client.test.ts` enforces that only `GET` requests reach the data API.
- **No secrets in output.** Tokens and the client secret must never appear in logs, errors or tool results.
- **stdout is for MCP only.** Anything the server prints for humans goes to stderr.

## Development

Requires Node.js 20.11+.

```bash
git clone https://github.com/royreznik/oura-ring-mcp.git
cd oura-ring-mcp
npm install          # installs dependencies and builds dist/
npm test             # unit, MCP integration, end-to-end and packaging tests (no network)
npm run test:coverage
npm run typecheck
npm run inspect      # explore the tools in the MCP Inspector
```

To try your changes against your own Oura account, connect once with `node dist/index.js auth` (see the README). Then:

- `npm run smoke:sandbox` calls every tool against Oura's public sandbox (no account needed).
- `npm run smoke:live` calls every tool against your real account, and forces one token refresh, printing only pass/fail and record counts.
- Point your MCP client at `node /path/to/oura-ring-mcp/dist/index.js` to try it in a conversation.

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under the project's [MIT License](LICENSE). Contributions must keep the [Privacy Policy](PRIVACY.md) accurate: if a change affects what data is read, stored or sent, update it in the same pull request.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Add or update tests for the behaviour you change.
3. Make sure `npm run typecheck` and `npm test` pass.
4. Update `README.md` / `docs/tools.md` if users will notice the change, and add a line under "Unreleased" in `CHANGELOG.md`.

## Releasing (maintainers)

1. Update `CHANGELOG.md`.
2. Run `npm version <patch|minor|major>`. This bumps `package.json`, `server.json` and the Claude Code plugin (`plugin/` and `.claude-plugin/marketplace.json`) together, and creates a `vX.Y.Z` tag.
3. Run `git push --follow-tags`. The Release workflow tests the code, publishes to npm with provenance, publishes to the MCP Registry, and creates the GitHub release with the `.mcpb` bundle attached.

Build the Claude Desktop bundle locally with `npm run bundle` (writes `build/oura-ring-mcp-<version>.mcpb`).
