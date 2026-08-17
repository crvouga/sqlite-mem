/**
 * Browser benchmark runner (Playwright).
 * Profiles: Chromium desktop, Chromium + Moto G4 + 4× CPU throttle.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";
import { toJson } from "../harness/report.ts";
import type { BenchReport, SuiteTier } from "../harness/types.ts";

const root = path.resolve(import.meta.dir, "../..");
const outDir = path.join(root, "benchmarks/results");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function ensureBuild(): Promise<void> {
  const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await build.exited) !== 0) throw new Error("package build failed");

  const bundle = Bun.spawn(
    [
      "bunx",
      "esbuild",
      "benchmarks/browser/client.ts",
      "--bundle",
      "--format=esm",
      "--outfile=benchmarks/browser/dist/client.js",
      "--platform=browser",
      "--target=es2022",
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if ((await bundle.exited) !== 0) throw new Error("benchmark client bundle failed");
}

function htmlPage(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>sqlite-mem benchmarks</title></head>
  <body>
    <pre id="out">running…</pre>
    <script type="module" src="/benchmarks/browser/dist/client.js"></script>
  </body>
</html>`;
}

async function serve(): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const filePath = path.join(root, url.pathname.slice(1));
      const file = Bun.file(filePath);
      if (!(await file.exists())) return new Response("missing", { status: 404 });
      const type = filePath.endsWith(".js")
        ? "text/javascript"
        : filePath.endsWith(".map")
          ? "application/json"
          : "text/html";
      return new Response(file, { headers: { "content-type": type } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

interface Profile {
  id: string;
  device?: (typeof devices)[string];
  cpuThrottle: number;
  tier: SuiteTier;
}

async function runProfile(url: string, profile: Profile): Promise<BenchReport> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(profile.device ? { ...profile.device } : {});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console:${msg.text()}`);
    });
    if (profile.cpuThrottle > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottle });
    }
    const target = `${url}?tier=${profile.tier}`;
    await page.goto(target, { waitUntil: "load" });
    await page.waitForFunction(() => (window as unknown as { __BENCH__?: unknown }).__BENCH__ !== undefined, null, {
      timeout: 10 * 60_000,
    });
    if (errors.length) throw new Error(`${profile.id} page errors: ${errors.join("; ")}`);
    const report = await page.evaluate(() => (window as unknown as { __BENCH__: BenchReport }).__BENCH__);
    report.environment.browser = "chromium";
    report.environment.cpuThrottle = profile.cpuThrottle;
    report.environment.deviceProfile = profile.id;
    const version = await browser.version();
    report.environment.runtimeVersion = version;
    return report;
  } finally {
    await browser.close();
  }
}

await ensureBuild();
const { url, stop } = await serve();
await mkdir(outDir, { recursive: true });
const desktopTier = (arg("--tier") ?? "ci") as SuiteTier;
const mobileTier = (arg("--mobile-tier") ?? "ci") as SuiteTier;

const profiles: Profile[] = [
  { id: "chromium-desktop", cpuThrottle: 1, tier: desktopTier },
  { id: "chromium-mobile-moto-g4", device: devices["Moto G4"], cpuThrottle: 4, tier: mobileTier },
];

let failed = false;
try {
  for (const profile of profiles) {
    console.log(`Running ${profile.id} tier=${profile.tier} throttle=${profile.cpuThrottle}x`);
    try {
      const report = await runProfile(url, profile);
      const outPath = path.join(outDir, `browser-${profile.id}.json`);
      await Bun.write(outPath, toJson(report));
      console.log(`${profile.id}: ${report.results.length} results → ${outPath}`);
    } catch (error) {
      failed = true;
      console.error(`✗ ${profile.id}:`, error);
    }
  }
} finally {
  stop();
}

if (failed) process.exit(1);
console.log("Browser benchmarks complete");
