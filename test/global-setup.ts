import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Builds dist/ once before any test file runs; e2e and packaging tests use the real build. */
export default function setup(): void {
  execFileSync("npm", ["run", "build"], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}
