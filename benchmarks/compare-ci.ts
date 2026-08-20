import path from "node:path";
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
const p95Factor = Number(process.env.BENCH_REGRESSION_FACTOR ?? 2.5);
const medianFactor = Number(process.env.BENCH_REGRESSION_MEDIAN ?? 1.5);
const currentByKey = new Map(current.results.map((result) => [`${result.engine}::${result.name}`, result]));
const p95Regressions: string[] = [];
const medianRegressions: string[] = [];
for (const base of baseline.results) {
  const match = currentByKey.get(`${base.engine}::${base.name}`);
  if (!match) continue;
  if (base.p95 > 0 && !(base.p95 < 0.05 && match.p95 < 0.2) && match.p95 > base.p95 * p95Factor) {
    p95Regressions.push(
      `${base.engine} ${base.name}: p95 ${base.p95.toFixed(3)}ms → ${match.p95.toFixed(3)}ms (${(match.p95 / base.p95).toFixed(2)}×)`,
    );
  }
  if (base.p50 > 0 && !(base.p50 < 0.05 && match.p50 < 0.2) && match.p50 > base.p50 * medianFactor) {
    // Sub-millisecond benches are noisy on shared CI runners: require p95 to also
    // exceed the median factor before failing (avoids median-only flaps).
    const noisy = base.p50 < 1 && base.p95 < 2;
    const p95AlsoBad = match.p95 > base.p95 * medianFactor;
    if (!noisy || p95AlsoBad) {
      medianRegressions.push(
        `${base.engine} ${base.name}: median ${base.p50.toFixed(3)}ms → ${match.p50.toFixed(3)}ms (${(match.p50 / base.p50).toFixed(2)}×)`,
      );
    }
  }
}

const sizeRegressions: string[] = [];
for (const base of baseline.results) {
  const match = currentByKey.get(`${base.engine}::${base.name}`);
  const before = base.extra?.snapshotBytes;
  const after = match?.extra?.snapshotBytes;
  if (typeof before === "number" && typeof after === "number" && before > 0 && after > before * p95Factor) {
    sizeRegressions.push(`${base.name}: snapshot ${before}B → ${after}B`);
  }
}

if (p95Regressions.length === 0 && medianRegressions.length === 0 && sizeRegressions.length === 0) {
  console.log(`No regressions vs ${baselinePath} (thresholds ${p95Factor}× p95, ${medianFactor}× median)`);
  process.exit(0);
}

console.error(`Performance regressions (>${p95Factor}× p95, >${medianFactor}× median, or snapshot size):`);
for (const line of p95Regressions) console.error(`  ${line}`);
for (const line of medianRegressions) console.error(`  ${line}`);
for (const line of sizeRegressions) console.error(`  ${line}`);
process.exit(1);
