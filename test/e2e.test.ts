// End-to-end tests: drive the built CLI and stdio server (see global-setup.ts) as subprocesses.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const bin = join(root, "dist", "index.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

function cli(args: string[], env: Record<string, string> = {}) {
  const tokenDir = mkdtempSync(join(tmpdir(), "oura-ring-mcp-e2e-"));
  const res = spawnSync(process.execPath, [bin, ...args], {
    env: { PATH: process.env.PATH ?? "", OURA_TOKEN_PATH: join(tokenDir, "tokens.json"), ...env },
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("CLI", () => {
  it("prints the version and usage", () => {
    expect(cli(["--version"]).stdout.trim()).toBe(pkg.version);
    const help = cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("oura-ring-mcp auth");
    expect(help.stdout).toContain("OURA_SANDBOX");
  });

  it("rejects unknown commands", () => {
    const res = cli(["frobnicate"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Unknown command: frobnicate");
  });

  it("status reports a missing connection", () => {
    const res = cli(["status"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Not connected");
  });

  it("auth explains how to get client credentials", () => {
    const res = cli(["auth"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("OURA_CLIENT_ID");
    expect(res.stderr).toContain("cloud.ouraring.com/oauth/applications");
  });

  it("logout deletes stored tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "oura-ring-mcp-e2e-"));
    const tokenPath = join(dir, "tokens.json");
    writeFileSync(tokenPath, "{}");
    const res = cli(["logout"], { OURA_TOKEN_PATH: tokenPath });
    expect(res.code).toBe(0);
    expect(() => statSync(tokenPath)).toThrow();
  });
});

describe("stdio server", () => {
  it("speaks MCP on stdout and logs only to stderr", async () => {
    const tokenDir = mkdtempSync(join(tmpdir(), "oura-ring-mcp-e2e-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { PATH: process.env.PATH ?? "", OURA_TOKEN_PATH: join(tokenDir, "tokens.json") },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport); // fails if anything non-JSON-RPC is written to stdout

    try {
      expect(client.getServerVersion()).toMatchObject({ name: "oura-ring-mcp", version: pkg.version });
      expect(client.getInstructions()).toContain("Read-only");

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(14);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

      const res = (await client.callTool({ name: "get_trends", arguments: { days: 7 } })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain("oura-ring-mcp auth");

      const invalid = (await client.callTool({ name: "get_trends", arguments: { days: 10_000 } })) as CallToolResult;
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(stderr).toContain(`oura-ring-mcp ${pkg.version} running on stdio`);
  });
});

describe("sandbox mode", () => {
  it("serves without any tokens when OURA_SANDBOX is set", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { PATH: process.env.PATH ?? "", OURA_SANDBOX: "1", OURA_TOKEN_PATH: join(tmpdir(), "does-not-exist.json") },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    await client.close();
    expect(stderr).toContain("sandbox data");
  });
});
