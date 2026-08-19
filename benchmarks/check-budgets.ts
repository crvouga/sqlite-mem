import budgets from "./budgets.json";
import { measureSmallRowFootprint } from "./workloads/memory-footprint.ts";

const budget = budgets.smallRows100k;
const measurement = measureSmallRowFootprint(budget.rows);
try {
  console.log(
    `Memory footprint (${measurement.rows} rows): ${measurement.heapBytes.toLocaleString()} heap bytes, ${measurement.bytesPerRow.toFixed(1)} bytes/row`,
  );
  const failures: string[] = [];
  if (measurement.heapBytes > budget.maxHeapBytes) {
    failures.push(`heap ${measurement.heapBytes} > budget ${budget.maxHeapBytes}`);
  }
  if (measurement.bytesPerRow > budget.maxBytesPerRow) {
    failures.push(`bytes/row ${measurement.bytesPerRow.toFixed(1)} > budget ${budget.maxBytesPerRow}`);
  }
  if (failures.length > 0) {
    console.error("Memory budget exceeded:");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  }
} finally {
  measurement.close();
}
