---
name: auth
description: Connect or reconnect the user's Oura account for the oura plugin. Use when an Oura tool returns "Not connected to Oura" or "rejected the refresh token", or when the user asks to set up, connect, check or disconnect their Oura Ring.
---

# Connect Oura

The oura plugin's tools need a one-time sign-in. The sign-in asks for a secret and opens a browser, so **the user must run it in their own terminal**. Never run `auth` yourself, and never ask the user to paste their client secret into the chat.

1. **Check the current state** by running:

   ```bash
   npx -y @royreznik/oura-ring-mcp@0.1.0 status
   ```

   If it prints `Connected …`, the plugin is ready and nothing else is needed.

2. **If not connected**, ask the user to:
   - Create an Oura API application at https://cloud.ouraring.com/oauth/applications with the redirect URI `http://localhost:8787/callback` (exactly as written).
   - Run this in a separate terminal window, paste the app's Client ID and Client Secret when asked (the secret is not echoed), and approve access in the browser, leaving every data type ticked:

     ```bash
     npx -y @royreznik/oura-ring-mcp@0.1.0 auth
     ```

3. **Common problems:**
   - `Port 8787 is in use`: another `auth` is still waiting; finish or close it, or wait 5 minutes for it to time out.
   - Oura reports a redirect URI error: the app's redirect URI must match `http://localhost:8787/callback` exactly.
   - A tool lists a data type under `unavailable`: that data type was unticked on Oura's consent page. Run `auth` again and allow it.

4. **After it prints `Connected …`**, retry the Oura question. No restart is needed: the server reads the new tokens on its next call.

To disconnect, the user can run `npx -y @royreznik/oura-ring-mcp@0.1.0 logout`. Everything is read-only.
