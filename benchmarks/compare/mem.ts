import { Database } from "../../src/index.ts";
import type { NamedFactory } from "../harness/types.ts";
import type { BenchEngine, BenchStatement } from "../harness/types.ts";

function wrapStatement(stmt: ReturnType<Database["prepare"]>): BenchStatement {
  return {
    run: (...params: unknown[]) => stmt.run(...params),
    all: <T = Record<string, unknown>>(...params: unknown[]) => stmt.all<T>(...params),
    get: <T = Record<string, unknown>>(...params: unknown[]) => stmt.get<T>(...params),
  };
}

export function createMemEngine(): BenchEngine {
  const db = new Database();
  return {
    name: "sqlite-mem",
    exec: (sql, params = []) => db.exec(sql, params),
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params),
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    transaction: (fn) => db.transaction(fn),
    snapshot: () => db.snapshot(),
    restore: (bytes) => db.restore(bytes),
    close: () => db.close(),
  };
}

export const memFactory: NamedFactory = { name: "sqlite-mem", create: createMemEngine };
