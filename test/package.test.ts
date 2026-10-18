// Release hygiene: registry metadata stays in sync and the npm tarball contains only the build.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

describe("MCP registry metadata", () => {
  it("server.json matches package.json", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      { registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } },
    ]);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});

describe("npm package", () => {
  it("publishes only the compiled server and docs", () => {
    const [packed] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
      }),
    ) as [{ files: { path: string }[] }];
    const files = packed.files.map((f) => f.path).sort();

    for (const file of files) {
      expect(file, `unexpected file in tarball: ${file}`).toMatch(/^(dist\/.+\.js(\.map)?|README\.md|LICENSE|package\.json)$/);
    }
    expect(files).toContain("dist/index.js");
    expect(files).toContain("LICENSE");
  });

  it("exposes the CLI and requires a supported Node", () => {
    expect(pkg.bin).toEqual({ "oura-ring-mcp": "dist/index.js" });
    expect(pkg.engines.node).toBe(">=20.11");
    expect(pkg.publishConfig).toEqual({ access: "public" });
  });
});

describe("Claude Code plugin", () => {
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json"));
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const mcp = JSON.parse(read("plugin/.mcp.json"));
  const spec = `${pkg.name}@${pkg.version}`;

  it("runs exactly the npm version being released", () => {
    expect(mcp.mcpServers.oura).toEqual({ command: "npx", args: ["-y", spec] });
    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.metadata.version).toBe(pkg.version);
    expect(marketplace.plugins.map((p: { version: string }) => p.version)).toEqual([pkg.version]);
  });

  it("tells users to run the same pinned version in the auth skill", () => {
    const pinned = [...read("plugin/skills/auth/SKILL.md").matchAll(/@royreznik\/oura-ring-mcp@[^\s`]+/g)].map((m) => m[0]);
    expect(pinned.length).toBeGreaterThan(0);
    expect(new Set(pinned)).toEqual(new Set([`@${spec.slice(1)}`]));
  });

  it("lists the plugin from this repository's plugin folder", () => {
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: "./plugin" })]);
    expect(plugin.license).toBe(pkg.license);
  });
});

describe("MCPB bundle manifest", () => {
  const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));

  it("starts the same entry point as the npm bin (tools are generated at build time)", () => {
    expect(manifest.tools).toEqual([]);
    expect(manifest.server.entry_point).toBe(pkg.bin["oura-ring-mcp"]);
    expect(manifest.server.mcp_config.args).toEqual([`\${__dirname}/${pkg.bin["oura-ring-mcp"]}`]);
    expect(manifest.description).toBe(server.description);
  });
});
