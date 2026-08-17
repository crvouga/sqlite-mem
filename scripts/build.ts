import { mkdir, rm } from "node:fs/promises";
import { $ } from "bun";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const build = Bun.spawn(
  [
    "bunx",
    "esbuild",
    "src/index.ts",
    "--bundle",
    "--format=esm",
    "--outfile=dist/index.js",
    "--platform=browser",
    "--target=es2022",
    "--sourcemap",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const code = await build.exited;
if (code !== 0) process.exit(code);

await $`tsc --emitDeclarationOnly --declaration --declarationMap --outDir dist`;

const mod = await import(new URL("../dist/index.js", import.meta.url).href);
if (typeof mod.Database !== "function") {
  console.error("Build incomplete: Database export missing at runtime");
  process.exit(1);
}

console.log("Built sqlite-mem → dist/");
