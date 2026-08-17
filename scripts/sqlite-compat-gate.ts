/**
 * Fail-closed SQLite compatibility gate (Scope 3).
 * Run: bun run scripts/sqlite-compat-gate.ts
 * Or:  bun run test:sqlite-compat
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInventoryReport } from "./sqlite-inventory.ts";

const ROOT = join(import.meta.dir, "..");
const COMPAT = join(ROOT, "compat");

interface CoverageFile {
  counts: {
    total: number;
    notApplicable: number;
    sqlBehavior: number;
    verified: number;
    partiallyVerified: number;
    unsupported: number;
    unknown: number;
  };
  coverage: Record<string, { status: string; evidence: string[]; notes: string }>;
}

function main(): void {
  const failures: string[] = [];

  const requirementsPath = join(COMPAT, "requirements.json");
  const coveragePath = join(COMPAT, "coverage.json");
  if (!existsSync(requirementsPath) || !existsSync(coveragePath)) {
    failures.push("compat/requirements.json or compat/coverage.json missing — run bun run scripts/sqlite-requirements.ts");
  } else {
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as CoverageFile;
    if (coverage.counts.unknown > 0) {
      failures.push(`${coverage.counts.unknown} SQL_BEHAVIOR requirements still unknown`);
    }
    // Ensure every coverage entry has a known status
    for (const [id, entry] of Object.entries(coverage.coverage)) {
      if (!["VERIFIED", "PARTIALLY_VERIFIED", "UNSUPPORTED", "NOT_APPLICABLE"].includes(entry.status)) {
        failures.push(`Requirement ${id} has invalid status ${entry.status}`);
      }
    }
  }

  const inventory = buildInventoryReport();
  if (inventory.referenceSqliteVersion !== "3.51.0") {
    failures.push(`Unexpected oracle version ${inventory.referenceSqliteVersion} (expected 3.51.0)`);
  }
  if (inventory.missingOracleFunctions.length > 0) {
    failures.push(
      `Missing ${inventory.missingOracleFunctions.length} oracle functions: ${inventory.missingOracleFunctions.slice(0, 20).join(", ")}${inventory.missingOracleFunctions.length > 20 ? "…" : ""}`,
    );
  }
  if (inventory.missingOracleModules.length > 0) {
    failures.push(`Missing oracle modules: ${inventory.missingOracleModules.join(", ")}`);
  }

  const reportPath = join(COMPAT, "gate-report.json");
  const report = {
    generatedAt: new Date().toISOString(),
    referenceSqliteVersion: inventory.referenceSqliteVersion,
    compileOptions: inventory.compileOptions,
    inventory,
    failures,
    ok: failures.length === 0,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    console.error("sqlite-compat gate FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("sqlite-compat gate OK");
  console.log(`  oracle ${inventory.referenceSqliteVersion}`);
  console.log(`  functions covered ${inventory.implementedOracleFunctions.length}`);
  console.log(`  modules covered ${inventory.memoryModules.length}`);
}

main();
