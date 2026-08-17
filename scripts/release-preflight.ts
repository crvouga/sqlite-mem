/**
 * Loud preflight checks before semantic-release runs on main.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
let failed = false;

function error(title: string, details: string[]): void {
  failed = true;
  console.error(`::error::${title}`);
  console.error("");
  console.error(`ERROR: ${title}`);
  console.error("=".repeat(72));
  for (const line of details) {
    console.error(line);
  }
  console.error("=".repeat(72));
  console.error("");
}

const npmToken = process.env.NPM_TOKEN?.trim() ?? "";
const inActions = process.env.GITHUB_ACTIONS === "true";
const oidcReady = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);

if (inActions && !npmToken && !oidcReady) {
  error("No npm publish credentials — cannot publish to npm", [
    "semantic-release needs credentials for https://registry.npmjs.org",
    "",
    "Option A (recommended): npm Trusted Publishing (OIDC)",
    "  1. https://www.npmjs.com/package/sqlite-mem → Settings → Trusted Publisher",
    "  2. Add GitHub Actions publisher:",
    "       Organization/user: crvouga",
    "       Repository: sqlite-mem",
    "       Workflow filename: ci.yml",
    "       Environment: (leave empty unless you use one)",
    "  3. Re-run this workflow (id-token: write is already set on the release job)",
    "",
    "Option B: Automation token secret",
    "  1. https://www.npmjs.com/settings/~/tokens → Generate new token → Granular",
    '     Access: Read and write for package "sqlite-mem"',
    "  2. GitHub repo → Settings → Secrets and variables → Actions",
    "  3. New repository secret name: NPM_TOKEN",
    "  4. Paste the token value and re-run this workflow",
    "",
    "Without this, publish fails with a cryptic npm 401.",
  ]);
}

if (inActions && !npmToken && oidcReady) {
  console.log(
    "release-preflight: NPM_TOKEN unset; using GitHub OIDC (npm Trusted Publishing must be configured for sqlite-mem).",
  );
}

for (const rel of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
  if (!existsSync(join(root, rel))) {
    error(`Missing ${rel} before release`, [
      "The release job must build and verify the package first.",
      "Run locally: bun run build && bun run verify-package",
    ]);
  }
}

const pkg = await Bun.file(join(root, "package.json")).json();
if (pkg.private === true) {
  error('package.json has "private": true', [
    "npm will refuse to publish a private package.",
    'Remove "private" from package.json.',
  ]);
}

if (failed) {
  console.error("release-preflight FAILED — refusing to run semantic-release.");
  process.exit(1);
}

console.log("release-preflight: OK");
console.log("  - build artifacts present");
if (npmToken) {
  console.log("  - NPM_TOKEN is set");
} else if (oidcReady) {
  console.log("  - OIDC token endpoint available (Trusted Publishing)");
} else {
  console.log("  - NPM_TOKEN unset (local dry-run)");
}
