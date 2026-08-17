import { Database as BunDatabase, SQLiteError } from "bun:sqlite";
import { categorizeErrorMessage, normalizeError } from "../harness/normalize.ts";
import { okResult } from "../harness/assert.ts";
import type {
  ContractDb,
  ContractStatement,
  ErrorCategory,
  QueryResult,
  SqlValue,
} from "../harness/types.ts";

function mapSqliteError(error: unknown): QueryResult {
  if (error instanceof SQLiteError) {
    return {
      ok: false,
      columns: [],
      rows: [],
      changes: 0,
      lastInsertRowid: 0,
      error: normalizeError(error.message, categorizeErrorMessage(error.message)),
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

function rowsFromAll(rows: Record<string, SqlValue>[]): { columns: string[]; rows: Record<string, SqlValue>[] } {
  if (rows.length === 0) {
    return { columns: [], rows: [] };
  }
  const columns = Object.keys(rows[0]!);
  return { columns, rows };
}

class RealSqliteStatement implements ContractStatement {
  private readonly stmt: ReturnType<BunDatabase["prepare"]>;
  private readonly onRun: (changes: number, lastInsertRowid: number | bigint) => void;

  constructor(
    stmt: ReturnType<BunDatabase["prepare"]>,
    onRun: (changes: number, lastInsertRowid: number | bigint) => void,
  ) {
    this.stmt = stmt;
    this.onRun = onRun;
  }

  bind(...params: SqlValue[]): ContractStatement {
    this.stmt.bind(...params as never[]);
    return this;
  }

  run(...params: SqlValue[]): QueryResult {
    try {
      const result = params.length > 0 ? this.stmt.run(...params as never[]) : this.stmt.run();
      this.onRun(result.changes, result.lastInsertRowid);
      return okResult([], [], result.changes, result.lastInsertRowid);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  all(...params: SqlValue[]): QueryResult {
    try {
      const rows = (params.length > 0 ? this.stmt.all(...params as never[]) : this.stmt.all()) as Record<
        string,
        SqlValue
      >[];
      const shaped = rowsFromAll(rows);
      return okResult(shaped.columns, shaped.rows);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  get(...params: SqlValue[]): QueryResult {
    try {
      const row = (params.length > 0 ? this.stmt.get(...params as never[]) : this.stmt.get()) as
        | Record<string, SqlValue>
        | undefined;
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

export class RealSqliteAdapter implements ContractDb {
  private db: BunDatabase;
  private lastChanges = 0;
  private lastInsertRowid: number | bigint = 0;
  private closed = false;

  constructor() {
    this.db = new BunDatabase(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  private recordRun(changes: number, lastInsertRowid: number | bigint): void {
    this.lastChanges = changes;
    this.lastInsertRowid = lastInsertRowid;
  }

  exec(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    try {
      const stmt = this.db.prepare(sql);
      const result = params && params.length > 0 ? stmt.run(...params as never[]) : stmt.run();
      this.recordRun(result.changes, result.lastInsertRowid);
      return okResult([], [], this.lastChanges, this.lastInsertRowid);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  query(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    try {
      const q = this.db.query(sql);
      const rows = (params && params.length > 0 ? q.all(...params as never[]) : q.all()) as Record<
        string,
        SqlValue
      >[];
      const shaped = rowsFromAll(rows);
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
      const stmt = this.db.prepare(sql);
      return new RealSqliteStatement(stmt, (changes, lastInsertRowid) => {
        this.recordRun(changes, lastInsertRowid);
      });
    } catch (error) {
      const mapped = mapSqliteError(error);
      throw new Error(mapped.error?.message ?? "prepare failed", {
        cause: { category: mapped.error?.category satisfies ErrorCategory | undefined },
      });
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.transaction(fn)();
  }

  snapshot(): Uint8Array {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    return this.db.serialize();
  }

  restore(bytes: Uint8Array): void {
    if (this.closed) {
      throw new Error("Database is closed");
    }
    this.db.close();
    this.db = BunDatabase.deserialize(bytes);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.lastChanges = 0;
    this.lastInsertRowid = 0;
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
