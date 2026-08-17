/**
 * Inventory oracle SQLite (bun:sqlite) builtins vs sqlite-mem registries.
 * Run: bun run scripts/sqlite-inventory.ts
 */
import { Database as BunDatabase } from "bun:sqlite";
import { aggregateFunctions } from "../src/functions/aggregate.ts";
import { dateTimeFunctions } from "../src/functions/datetime.ts";
import { jsonAggregateFunctions, jsonScalarFunctions } from "../src/functions/json.ts";
import { getScalarFunctions } from "../src/functions/scalar.ts";
import { listTableValuedFunctions } from "../src/functions/table-valued.ts";
import { windowFunctions } from "../src/functions/window.ts";

const ORACLE_OPERATORS = ["->", "->>"] as const;
const MEMORY_OPERATORS = ["->", "->>"] as const;
const MEMORY_MODULES = ["fts5"];

function main(): void {
  const db = new BunDatabase(":memory:");
  const version = String(db.prepare("select sqlite_version()").get()?.["sqlite_version()"] ?? "?");
  const compileOptions = db.prepare("pragma compile_options").all().map((r) => String((r as { compile_options: string }).compile_options));
  const functions = db
    .prepare("select name, type, narg from pragma_function_list() order by name, type, narg")
    .all() as Array<{ name: string; type: string; narg: number }>;
  const modules = db
    .prepare("select name from pragma_module_list() order by name")
    .all()
    .map((r) => String((r as { name: string }).name));

  const memScalars = new Set([
    ...Object.keys(getScalarFunctions()),
    ...Object.keys(dateTimeFunctions),
    ...Object.keys(jsonScalarFunctions),
  ]);
  const memAggs = new Set([...Object.keys(aggregateFunctions), ...Object.keys(jsonAggregateFunctions)]);
  const memWindows = new Set(Object.keys(windowFunctions));
  const memTvf = new Set(listTableValuedFunctions());
  const memNames = new Set([...memScalars, ...memAggs, ...memWindows, ...memTvf, ...MEMORY_OPERATORS]);

  const oracleNames = new Set<string>();
  for (const f of functions) oracleNames.add(f.name.toLowerCase());
  for (const op of ORACLE_OPERATORS) oracleNames.add(op);

  const missing: string[] = [];
  const present: string[] = [];
  for (const name of [...oracleNames].sort()) {
    if (memNames.has(name)) present.push(name);
    else missing.push(name);
  }

  const extra = [...memNames].filter((n) => !oracleNames.has(n)).sort();

  const report = {
    referenceSqliteVersion: version,
    compileOptions,
    oracleFunctionCount: functions.length,
    oracleModules: modules,
    memoryModules: MEMORY_MODULES,
    implementedOracleFunctions: present,
    missingOracleFunctions: missing,
    memoryOnlyFunctions: extra,
    jsonOracleFunctions: [...oracleNames].filter((n) => n.includes("json") || n === "->" || n === "->>").sort(),
    jsonImplemented: [...present].filter((n) => n.includes("json") || n === "->" || n === "->>").sort(),
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
