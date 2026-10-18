// Keeps every file that pins the release version in step with package.json. Runs on `npm version`.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const spec = `${pkg.name}@${pkg.version}`;

function updateJson(file, change) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  change(data);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// MCP Registry metadata.
updateJson("server.json", (server) => {
  server.name = pkg.mcpName;
  server.version = pkg.version;
  for (const p of server.packages) {
    if (p.registryType === "npm") {
      p.identifier = pkg.name;
      p.version = pkg.version;
    }
  }
});

// Claude Code plugin and marketplace: the plugin runs exactly this npm version.
updateJson("plugin/.claude-plugin/plugin.json", (plugin) => {
  plugin.version = pkg.version;
});
updateJson(".claude-plugin/marketplace.json", (marketplace) => {
  marketplace.metadata.version = pkg.version;
  for (const entry of marketplace.plugins) entry.version = pkg.version;
});
updateJson("plugin/.mcp.json", (config) => {
  config.mcpServers.oura.args = ["-y", spec];
});
const skill = "plugin/skills/auth/SKILL.md";
const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
writeFileSync(skill, readFileSync(skill, "utf8").replace(new RegExp(`${escaped}@[0-9][^\\s\`]*`, "g"), spec));

console.log(`Pinned ${spec} in server.json, the Claude Code plugin and the marketplace`);
