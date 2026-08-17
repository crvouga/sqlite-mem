import { Database, SqliteError, type Statement } from "../../src/index.ts";
import { normalizeError } from "../harness/normalize.ts";
import { okResult } from "../harness/assert.ts";
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

function rowsFromRecords(rows: Record<string, SqlValue>[]): { columns: string[]; rows: Record<string, SqlValue>[] } {
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
      const rows = this.stmt.all(...params) as Record<string, SqlValue>[];
      const shaped = rowsFromRecords(rows);
      return okResult(shaped.columns, shaped.rows);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  get(...params: SqlValue[]): QueryResult {
    try {
      const row = this.stmt.get(...params) as Record<string, SqlValue> | undefined;
      if (!row) {
        return okResult([], []);
      }
      const columns = Object.keys(row);
      return okResult(columns, [row]);
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
      const rows = this.db.query<Record<string, SqlValue>>(sql, params);
      const shaped = rowsFromRecords(rows);
      return okResult(shaped.columns, shaped.rows);
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
