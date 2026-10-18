# Changelog

## [Unreleased]

## [1.0.0]

First stable release. Tool names, inputs and output shapes are now covered by semver: breaking changes will only ship in a new major version.

- `get_profile` declares an explicit (empty) input schema with zod, so every tool declares one.
- Verified on a real Oura account: all 14 tools, OAuth with PKCE, and single-use refresh-token rotation.
- Listed on npm, the MCP Registry, Glama (all tools rated A) and M8ven (A, Trusted).

## [0.1.1]

- Rewrote every tool description to say what the tool does, when to use it instead of its siblings, and how ranges, ordering, pagination and missing days behave.
- `get_heart_rate` returns `truncated: true` instead of a `next_token` it had no way to accept back.
- Built with TypeScript 7.

## [0.1.0]

- First release: 14 read-only tools over the Oura API v2 (daily overview, trends, readiness, sleep scores, sleep periods with hypnograms, activity, workouts, sessions, stress/resilience/SpO2/cardiovascular age/VO2 max, tags, rest mode, heart rate, profile).
- OAuth 2 with PKCE, single-use refresh-token rotation with a cross-process lock.
- `OURA_SANDBOX=1` serves Oura's public sample data without an account.
