import path from "node:path";
import budgets from "./budgets.json";
import type { BenchReport } from "./harness/types.ts";
import { measureSmallRowFootprint } from "./workloads/memory-footprint.ts";

const failures: string[] = [];

// 1. Memory footprint budget (measured directly).
const memBudget = budgets.smallRows100k;
const measurement = measureSmallRowFootprint(memBudget.rows);
try {
  console.log(
    `Memory footprint (${measurement.rows} rows): ${measurement.heapBytes.toLocaleString()} heap bytes, ${measurement.bytesPerRow.toFixed(1)} bytes/row`,
  );
  if (measurement.heapBytes > memBudget.maxHeapBytes) {
    failures.push(`heap ${measurement.heapBytes} > budget ${memBudget.maxHeapBytes}`);
  }
  if (measurement.bytesPerRow > memBudget.maxBytesPerRow) {
    failures.push(`bytes/row ${measurement.bytesPerRow.toFixed(1)} > budget ${memBudget.maxBytesPerRow}`);
  }
} finally {
  measurement.close();
}

// 2. Timing budgets against the latest ci-tier run (~3× linux baseline medians,
//    so CI noise does not flake). n<5 ratio gates are skipped in compare-ci.ts.
const latestPath = process.argv[2] ?? path.join(import.meta.dir, "results/ci-latest.json");
const latestFile = Bun.file(latestPath);
if (await latestFile.exists()) {
  const report = (await latestFile.json()) as BenchReport;
  const byName = new Map(report.results.filter((r) => r.engine === "sqlite-mem").map((r) => [r.name, r] as const));
  const budgeted = Object.entries(budgets.ciMedianMs as Record<string, number>);
  let checked = 0;
  for (const [name, maxMedianMs] of budgeted) {
    const result = byName.get(name);
    if (!result) continue;
    checked++;
    const median = result.p50 || result.mean;
    if (median > maxMedianMs) {
      failures.push(`${name}: median ${median.toFixed(3)}ms > budget ${maxMedianMs}ms`);
    }
  }
  console.log(`Timing budgets: ${checked}/${budgeted.length} benchmarks checked against ${latestPath}`);
} else {
  console.warn(`Timing budgets skipped: ${latestPath} not found (run \`bun run benchmark:ci\` to produce it)`);
}

if (failures.length > 0) {
  console.error("Budget exceeded:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log("All budgets OK");
}
