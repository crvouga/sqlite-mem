import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { listMemoryFunctionNames } from "../../../scripts/sqlite-inventory.ts";

/**
 * Scope-3: every oracle-exposed SQL function name must be present in sqlite-mem.
 */
describe("function inventory vs oracle", () => {
  test("oracle SQL surface is a subset of sqlite-mem registries", () => {
    const db = new BunDatabase(":memory:");
    const names = new Set(
      (db.prepare("select name from pragma_function_list()").all() as Array<{ name: string }>).map((r) =>
        r.name.toLowerCase(),
      ),
    );
    names.add("->");
    names.add("->>");
    const mem = listMemoryFunctionNames();
    const missing = [...names].filter((n) => !mem.has(n)).sort();
    expect(missing).toEqual([]);
  });

  test("JSON surface from oracle is implemented", () => {
    const db = new BunDatabase(":memory:");
    const names = new Set(
      (db.prepare("select name from pragma_function_list()").all() as Array<{ name: string }>).map((r) =>
        r.name.toLowerCase(),
      ),
    );
    names.add("->");
    names.add("->>");
    const mem = listMemoryFunctionNames();
    const jsonOracle = [...names].filter((n) => n.includes("json") || n === "->" || n === "->>").sort();
    const missingJson = jsonOracle.filter((n) => !mem.has(n));
    expect(missingJson).toEqual([]);
  });

  test("representative Scope-3 builtins are present", () => {
    const mem = listMemoryFunctionNames();
    for (const name of ["sin", "cos", "pow", "sqrt", "instr", "concat", "unicode", "unixepoch", "ntile", "uuid"]) {
      expect(mem.has(name)).toBe(true);
    }
  });
});
