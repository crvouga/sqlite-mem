import { expect } from "bun:test";
import { deepCompareResults, normalizeError } from "./normalize.ts";
import type { QueryResult, SqlValue } from "./types.ts";

export function expectParity(a: QueryResult, b: QueryResult): void {
  const comparison = deepCompareResults(a, b);
  if (!comparison.equal) {
    expect(comparison.reason ?? "results differ").toBe(undefined);
  }
}

function errorFromUnknown(error: unknown): QueryResult {
  if (error && typeof error === "object" && "category" in error && "message" in error) {
    const err = error as { category?: QueryResult["error"] extends infer E ? E extends { category: infer C } ? C : never : never; message: string };
    return {
      ok: false,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      error: normalizeError(err.message, err.category as QueryResult["error"] extends { category: infer C } ? C : never),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    columns: [],
    rows: [],
    changes: 0,
    lastInsertRowid: 0,
    error: normalizeError(message),
  };
}

export function runCatching(fn: () => QueryResult | undefined): QueryResult {
  try {
    const result = fn();
    if (result && typeof result === "object" && "ok" in result) {
      return result;
    }
    return {
      ok: true,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
    };
  } catch (error) {
    return errorFromUnknown(error);
  }
}

export function okResult(
  columns: string[],
  rows: Record<string, SqlValue>[],
  changes = 0,
  lastInsertRowid: number | bigint = 0,
): QueryResult {
  return {
    ok: true,
    columns,
    rows,
    changes,
    lastInsertRowid,
  };
}
