// Builds two bundles of the same server (usage: npm run bundle):
// - build/oura-ring-mcp-<version>.mcpb: standard MCPB bundle for Claude Desktop
// - build/oura-ring-mcp-<version>-smithery.mcpb: same, but its manifest also carries each tool's
//   inputSchema/annotations, which Smithery requires and the strict MCPB schema rejects.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const stage = "build/mcpb";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("mcpb/manifest.json", "utf8"));
manifest.version = pkg.version;

const run = (cmd, args, cwd = ".") =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

rmSync("build", { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
run("npm", ["run", "build"]);

// Tool definitions come from the built server itself, so the bundle can't drift from it.
// Directories such as Smithery require each tool's full inputSchema.
const { createServer } = await import("../dist/server.js");
const { OuraClient } = await import("../dist/client.js");
const unused = { getAccessToken: async () => "", forceRefresh: async () => "" };
const server = createServer(new OuraClient(unused), pkg.version);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "build-mcpb", version: pkg.version });
await client.connect(clientSide);
const { tools } = await client.listTools();
await client.close();
manifest.tools = tools.map(({ name, description }) => ({ name, description }));

cpSync("dist", `${stage}/dist`, { recursive: true });
for (const file of ["package.json", "package-lock.json", "LICENSE", "README.md"]) cpSync(file, `${stage}/${file}`);
writeFileSync(`${stage}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
run("npx", ["-y", MCPB, "validate", `${stage}/manifest.json`]);
const bundle = `build/oura-ring-mcp-${pkg.version}.mcpb`;
run("npx", ["-y", MCPB, "pack", stage, bundle]);

// Smithery variant: identical archive, manifest.json replaced with full tool definitions.
const smithery = `build/oura-ring-mcp-${pkg.version}-smithery.mcpb`;
const extended = "build/smithery-manifest";
mkdirSync(extended, { recursive: true });
const fullTools = tools.map(({ name, title, description, inputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  annotations,
}));
writeFileSync(`${extended}/manifest.json`, JSON.stringify({ ...manifest, tools: fullTools }, null, 2) + "\n");
cpSync(bundle, smithery);
run("zip", ["-q", resolve(smithery), "manifest.json"], extended);
console.log(`Smithery bundle: ${smithery}`);
