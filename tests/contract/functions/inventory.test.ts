import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { aggregateFunctions } from "../../../src/functions/aggregate.ts";
import { dateTimeFunctions } from "../../../src/functions/datetime.ts";
import { jsonAggregateFunctions, jsonScalarFunctions } from "../../../src/functions/json.ts";
import { getScalarFunctions } from "../../../src/functions/scalar.ts";
import { listTableValuedFunctions } from "../../../src/functions/table-valued.ts";
import { windowFunctions } from "../../../src/functions/window.ts";

/**
 * Documents the deliberate gap between bun:sqlite's builtin surface and sqlite-mem.
 * JSON/JSONB are required to be present; math/rtree/uuid/etc. remain UNSUPPORTED.
 */
describe("function inventory vs oracle", () => {
  test("JSON surface from oracle is implemented", () => {
    const db = new BunDatabase(":memory:");
    const names = new Set(
      (db.prepare("select name from pragma_function_list()").all() as Array<{ name: string }>)
        .map((r) => r.name.toLowerCase()),
    );
    names.add("->");
    names.add("->>");
    const mem = new Set([
      ...Object.keys(getScalarFunctions()),
      ...Object.keys(dateTimeFunctions),
      ...Object.keys(jsonScalarFunctions),
      ...Object.keys(aggregateFunctions),
      ...Object.keys(jsonAggregateFunctions),
      ...Object.keys(windowFunctions),
      ...listTableValuedFunctions(),
      "->",
      "->>",
    ]);
    const jsonOracle = [...names].filter((n) => n.includes("json") || n === "->" || n === "->>").sort();
    const missingJson = jsonOracle.filter((n) => !mem.has(n));
    expect(missingJson).toEqual([]);
  });

  test("unsupported oracle builtins are explicitly absent", () => {
    const memScalars = new Set([
      ...Object.keys(getScalarFunctions()),
      ...Object.keys(dateTimeFunctions),
      ...Object.keys(jsonScalarFunctions),
    ]);
    // Representative UNSUPPORTED builtins from ENABLE_MATH_FUNCTIONS / extras.
    for (const name of ["sin", "cos", "pow", "sqrt", "instr", "concat", "unicode", "unixepoch", "ntile"]) {
      expect(memScalars.has(name) || name in windowFunctions).toBe(false);
    }
  });
});
