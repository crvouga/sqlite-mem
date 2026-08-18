import path from "node:path";
import { compareReports } from "./harness/report.ts";
import type { BenchReport } from "./harness/types.ts";

const root = path.resolve(import.meta.dir);
const baselinePath = process.argv[2] ?? path.join(root, "results/ci-baseline.json");
const currentPath = process.argv[3] ?? path.join(root, "results/ci-latest.json");

const baselineFile = Bun.file(baselinePath);
const currentFile = Bun.file(currentPath);
if (!(await baselineFile.exists())) {
  console.error(`missing baseline: ${baselinePath}`);
  process.exit(1);
}
if (!(await currentFile.exists())) {
  console.error(`missing current results: ${currentPath}`);
  process.exit(1);
}

const baseline = (await baselineFile.json()) as BenchReport;
const current = (await currentFile.json()) as BenchReport;
const basePlatform = baseline.environment.platform;
const currentPlatform = current.environment.platform;
if (basePlatform && currentPlatform && basePlatform !== currentPlatform) {
  console.error(
    `Baseline platform=${basePlatform} current=${currentPlatform}. Re-record benchmarks/results/ci-baseline.json on ${currentPlatform} (CI is linux). The regression gate fails closed on a platform mismatch.`,
  );
  process.exit(1);
}
const slowerThan = Number(process.env.BENCH_REGRESSION_FACTOR ?? 2.5);
const regressions = compareReports(baseline, current, slowerThan);

const sizeRegressions: string[] = [];
const currentByKey = new Map(current.results.map((result) => [`${result.engine}::${result.name}`, result]));
for (const base of baseline.results) {
  const match = currentByKey.get(`${base.engine}::${base.name}`);
  const before = base.extra?.snapshotBytes;
  const after = match?.extra?.snapshotBytes;
  if (typeof before === "number" && typeof after === "number" && before > 0 && after > before * slowerThan) {
    sizeRegressions.push(`${base.name}: snapshot ${before}B → ${after}B`);
  }
}

if (regressions.length === 0 && sizeRegressions.length === 0) {
  console.log(`No regressions vs ${baselinePath} (threshold ${slowerThan}× p95)`);
  process.exit(0);
}

console.error(`Performance regressions (>${slowerThan}× p95 or snapshot size):`);
for (const item of regressions) {
  console.error(
    `  ${item.engine} ${item.name}: p95 ${item.baselineP95.toFixed(3)}ms → ${item.currentP95.toFixed(3)}ms (${item.ratio.toFixed(2)}×)`,
  );
}
for (const line of sizeRegressions) console.error(`  ${line}`);
process.exit(1);
