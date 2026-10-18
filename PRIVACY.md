# Privacy Policy

oura-ring-mcp is open-source software that runs **on your own computer**. There is no oura-ring-mcp server, account or database, and it sends **no telemetry** to anyone.

## What it accesses

When you run `oura-ring-mcp auth`, you authorize your own Oura API application to read these Oura scopes: `email`, `personal` (age, sex, height, weight), `daily` (readiness, sleep and activity summaries, stress, resilience), `heartrate`, `workout`, `tag`, `session`, `spo2`, `stress` (stress and resilience), `heart_health` (cardiovascular age, VO2 max) and `ring_configuration` (ring model, size, firmware). You can untick any of them on Oura's consent page. Data is fetched only when your MCP client calls a tool.

## What is stored

| Data | Where | How long |
| --- | --- | --- |
| Client ID, client secret, OAuth tokens | `~/.config/oura-ring-mcp/tokens.json`, readable only by your user | Until `oura-ring-mcp logout` or you delete the file |
| Your Oura health data | Nowhere; held in memory while a request is answered | Not stored |

## Who receives your data

- **Oura**, to authenticate and serve your data ([Oura privacy policy](https://ouraring.com/privacy-policy)).
- **Your MCP client and its AI model provider**, which receive tool results to answer your questions. Choose ones you trust with health data.
- **No one else.**

## Not medical advice

oura-ring-mcp and answers derived from your Oura data are not medical advice.
