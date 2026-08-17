import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { RealSqliteAdapter } from "../adapters/real-sqlite.ts";
import { deepCompareResults } from "../harness/normalize.ts";
import type { ContractDb, QueryResult, SqlValue } from "../harness/types.ts";
import { fuzzSeed } from "./config.ts";

export function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0";
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`;
}

export function compareOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  sqlite: QueryResult,
): void {
  const comparison = deepCompareResults(memory, sqlite);
  if (comparison.equal) return;

  throw new Error(
    [
      `Differential mismatch (${label})`,
      `seed=${fuzzSeed()}`,
      `Replay: SQLITE_MEM_FUZZ_SEED=${fuzzSeed()} bun test tests/fuzz`,
      `SQL: ${sql}`,
      `Setup: ${JSON.stringify(setup)}`,
      `Reason: ${comparison.reason}`,
      `memory: ${JSON.stringify(memory)}`,
      `sqlite: ${JSON.stringify(sqlite)}`,
    ].join("\n"),
  );
}

export function compareOutcomeOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  sqlite: QueryResult,
): void {
  const sameOutcome =
    memory.ok === sqlite.ok &&
    (memory.ok || memory.error?.category === sqlite.error?.category);
  if (sameOutcome) return;

  throw new Error(
    [
      `Differential outcome mismatch (${label})`,
      `seed=${fuzzSeed()}`,
      `Replay: SQLITE_MEM_FUZZ_SEED=${fuzzSeed()} bun test tests/fuzz`,
      `SQL: ${sql}`,
      `Setup: ${JSON.stringify(setup)}`,
      `memory: ${JSON.stringify(memory)}`,
      `sqlite: ${JSON.stringify(sqlite)}`,
    ].join("\n"),
  );
}

export function withDatabases(run: (memory: ContractDb, sqlite: ContractDb) => void): void {
  const memory = new InMemoryAdapter();
  const sqlite = new RealSqliteAdapter();
  try {
    run(memory, sqlite);
  } finally {
    memory.close();
    sqlite.close();
  }
}
