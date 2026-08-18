/**
 * Browser smoke runner using Playwright.
 * Builds the package, serves dist via a tiny HTML page, and verifies Database works
 * in Chromium, Firefox, and WebKit without Node/Bun/WASM APIs.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type BrowserType, chromium, firefox, webkit } from "playwright";

const root = path.resolve(import.meta.dir, "../..");
const _distDir = path.join(root, "dist");

async function ensureBuild(): Promise<void> {
  if (process.env.SQLITE_MEM_BROWSER_SKIP_BUILD === "1") {
    const dist = Bun.file(path.join(root, "dist/index.js"));
    if (!(await dist.exists())) {
      throw new Error("SQLITE_MEM_BROWSER_SKIP_BUILD=1 but dist/index.js is missing; run bun run build first");
    }
    return;
  }
  const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await build.exited;
  if (code !== 0) throw new Error("build failed");
}

function htmlPage(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>sqlite-mem browser smoke</title></head>
  <body>
    <pre id="out">running…</pre>
    <script type="module">
      import { Database } from "/dist/index.js";
      const out = document.getElementById("out");
      try {
        const db = new Database();
        db.exec(\`
          CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT);
        \`);
        const insertUser = db.prepare("INSERT INTO users(name) VALUES (?)");
        insertUser.run("Alice");
        insertUser.run("Bob");
        db.exec("INSERT INTO posts(user_id, title) VALUES (?, ?)", [1, "Hello"]);
        db.exec("INSERT INTO posts(user_id, title) VALUES (?, ?)", [1, "World"]);

        let rolledBack = false;
        try {
          db.transaction(() => {
            db.exec("INSERT INTO users(name) VALUES (?)", ["Zed"]);
            throw new Error("boom");
          });
        } catch (error) {
          rolledBack = error && error.message === "boom";
        }

        const users = db.query("SELECT id, name FROM users ORDER BY id");
        const joined = db.query(\`
          SELECT u.name, count(p.id) AS posts
          FROM users u
          LEFT JOIN posts p ON p.user_id = u.id
          GROUP BY u.id, u.name
          ORDER BY u.id
        \`);
        const snap = db.snapshot();
        const db2 = new Database();
        db2.restore(snap);
        const users2 = db2.query("SELECT id, name FROM users ORDER BY id");
        const ok =
          rolledBack &&
          Array.isArray(users) &&
          users.length === 2 &&
          users[0].name === "Alice" &&
          users[1].name === "Bob" &&
          Array.isArray(joined) &&
          joined.length === 2 &&
          joined[0].posts === 2 &&
          joined[1].posts === 0 &&
          users2.length === 2 &&
          users2[0].name === "Alice" &&
          snap instanceof Uint8Array &&
          snap.byteLength > 0;
        out.textContent = ok ? "OK:" + JSON.stringify({ users, joined }) : "FAIL:" + JSON.stringify({ users, joined, users2, rolledBack });
        window.__SMOKE__ = { ok, users, joined, users2, rolledBack, snapLength: snap.byteLength };
      } catch (error) {
        out.textContent = "ERROR:" + (error && error.message ? error.message : String(error));
        window.__SMOKE__ = { ok: false, error: String(error) };
      }
    </script>
  </body>
</html>`;
}

async function serve(): Promise<{ url: string; stop: () => void }> {
  await mkdir(path.join(root, "tests/browser"), { recursive: true });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname.startsWith("/dist/")) {
        const filePath = path.join(root, url.pathname.slice(1));
        const file = Bun.file(filePath);
        if (!(await file.exists())) return new Response("missing", { status: 404 });
        const type = filePath.endsWith(".js")
          ? "text/javascript"
          : filePath.endsWith(".map")
            ? "application/json"
            : "application/octet-stream";
        return new Response(file, { headers: { "content-type": type } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}

async function runBrowser(type: BrowserType, name: string, url: string): Promise<void> {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console:${msg.text()}`);
    });
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => (window as unknown as { __SMOKE__?: unknown }).__SMOKE__ !== undefined, null, {
      timeout: 30_000,
    });
    const result = await page.evaluate(
      () => (window as unknown as { __SMOKE__: { ok: boolean; error?: string } }).__SMOKE__,
    );
    if (errors.length) {
      throw new Error(`${name} page errors: ${errors.join("; ")}`);
    }
    if (!result?.ok) {
      throw new Error(`${name} smoke failed: ${JSON.stringify(result)}`);
    }
    console.log(`✓ ${name}`);
  } finally {
    await browser.close();
  }
}

await ensureBuild();

const { url, stop } = await serve();
console.log(`Serving smoke page at ${url}`);

const browsers: Array<[BrowserType, string]> = [
  [chromium, "chromium"],
  [firefox, "firefox"],
  [webkit, "webkit"],
];

let failed = false;
try {
  for (const [type, name] of browsers) {
    try {
      await runBrowser(type, name, url);
    } catch (error) {
      failed = true;
      console.error(`✗ ${name}:`, error);
    }
  }
} finally {
  stop();
}

if (failed) process.exit(1);
console.log("Browser smoke passed on chromium, firefox, webkit");
