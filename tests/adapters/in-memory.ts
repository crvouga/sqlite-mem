import { Database, SqliteError, type Statement } from "../../src/index.ts";
import { okResult } from "../harness/assert.ts";
import { normalizeError } from "../harness/normalize.ts";
import type { ContractDb, ContractStatement, QueryResult, SqlValue } from "../harness/types.ts";

function mapSqliteError(error: unknown): QueryResult {
  if (error instanceof SqliteError) {
    return {
      ok: false,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      error: normalizeError(error.message, error.category),
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

function _rowsFromRecords(rows: Record<string, SqlValue>[]): { columns: string[]; rows: Record<string, SqlValue>[] } {
  if (rows.length === 0) {
    return { columns: [], rows: [] };
  }
  return { columns: Object.keys(rows[0]!), rows };
}

class InMemoryStatement implements ContractStatement {
  private readonly stmt: Statement;

  constructor(stmt: Statement) {
    this.stmt = stmt;
  }

  bind(...params: SqlValue[]): ContractStatement {
    this.stmt.bind(...params);
    return this;
  }

  run(...params: SqlValue[]): QueryResult {
    try {
      const result = this.stmt.run(...params);
      return okResult([], [], result.changes, result.lastInsertRowid);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  all(...params: SqlValue[]): QueryResult {
    try {
      const result = this.stmt.result(...params);
      return okResult(
        [...result.columns],
        result.rows as Record<string, SqlValue>[],
        0,
        0,
        result.values?.map((row) => [...row]),
      );
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  get(...params: SqlValue[]): QueryResult {
    try {
      const result = this.stmt.result(...params);
      if (result.rows.length === 0) {
        return okResult([...result.columns], [], 0, 0, []);
      }
      return okResult(
        [...result.columns],
        [result.rows[0] as Record<string, SqlValue>],
        0,
        0,
        result.values ? [[...result.values[0]!]] : undefined,
      );
    } catch (error) {
      return mapSqliteError(error);
    }
  }
}

export function safeExec(db: Database, sql: string, params?: SqlValue[]): QueryResult {
  try {
    db.exec(sql, params);
    return okResult([], [], db.changes, db.lastInsertRowid);
  } catch (error) {
    return mapSqliteError(error);
  }
}

export class InMemoryAdapter implements ContractDb {
  private readonly db: Database;
  private closed = false;

  constructor(options?: ConstructorParameters<typeof Database>[0]) {
    this.db = new Database(options);
  }

  exec(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    return safeExec(this.db, sql, params);
  }

  query(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    try {
      const result = this.db.prepare(sql).result(...(params ?? []));
      // Query comparisons focus on columns/rows; write counters stay on exec/run.
      return okResult(
        [...result.columns],
        result.rows as Record<string, SqlValue>[],
        0,
        0,
        result.values?.map((row) => [...row]),
      );
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  prepare(sql: string): ContractStatement {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    try {
      return new InMemoryStatement(this.db.prepare(sql));
    } catch (error) {
      const mapped = mapSqliteError(error);
      throw new Error(mapped.error?.message ?? "prepare failed", { cause: error });
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.transaction(fn);
  }

  snapshot(): Uint8Array {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.snapshot();
  }

  restore(bytes: Uint8Array): void {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    this.db.restore(bytes);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private closedError(): QueryResult {
    return {
      ok: false,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      error: normalizeError("Database is closed", "misuse"),
    };
  }
}
