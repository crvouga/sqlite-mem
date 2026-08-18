import { Database as BunDatabase, SQLiteError } from "bun:sqlite";
import { okResult } from "../harness/assert.ts";
import { categorizeErrorMessage, normalizeError } from "../harness/normalize.ts";
import type { ContractDb, ContractStatement, ErrorCategory, QueryResult, SqlValue } from "../harness/types.ts";

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

function shapeStatementResult(stmt: ReturnType<BunDatabase["prepare"]>, params?: SqlValue[]): QueryResult {
  const columns = columnNamesFromStatement(stmt);
  let typeWidth = 0;
  try {
    typeWidth = Array.isArray(stmt.columnTypes) ? stmt.columnTypes.length : 0;
  } catch {
    // bun:sqlite throws for non-read-only statements (e.g. INSERT RETURNING).
    typeWidth = 0;
  }

  const rawValues = params && params.length > 0 ? stmt.values(...(params as never[])) : stmt.values();
  const valueRows = (rawValues ? [...rawValues] : []) as SqlValue[][];

  const width = Math.max(typeWidth, valueRows[0]?.length ?? 0, columns.length);
  const resolvedColumns = columns.length > 0 ? columns : Array.from({ length: width }, (_, i) => `column${i}`);
  const rows = valueRows.map((values) => {
    const object: Record<string, SqlValue> = {};
    for (let i = 0; i < width; i++) {
      const name = resolvedColumns[i] ?? `column${i}`;
      if (!(name in object)) object[name] = values[i] ?? null;
    }
    return object;
  });
  return okResult(resolvedColumns, rows, 0, 0, valueRows);
}

function columnNamesFromStatement(stmt: { columnNames?: string[] }): string[] {
  return Array.isArray(stmt.columnNames) ? [...stmt.columnNames] : [];
}

function isMultiStatement(sql: string): boolean {
  const parts = sql
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1;
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

  run(...params: SqlValue[]): QueryResult {
    try {
      const result = params.length > 0 ? this.stmt.run(...(params as never[])) : this.stmt.run();
      this.onRun(result.changes, result.lastInsertRowid);
      return okResult([], [], result.changes, result.lastInsertRowid);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  all(...params: SqlValue[]): QueryResult {
    try {
      return shapeStatementResult(this.stmt, params);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  get(...params: SqlValue[]): QueryResult {
    try {
      const shaped = shapeStatementResult(this.stmt, params);
      if (shaped.rows.length === 0) {
        return okResult(shaped.columns, [], 0, 0, []);
      }
      return okResult(shaped.columns, [shaped.rows[0]!], 0, 0, shaped.values ? [shaped.values[0]!] : undefined);
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
      if (params && params.length > 0) {
        const stmt = this.db.prepare(sql);
        const result = stmt.run(...(params as never[]));
        this.recordRun(result.changes, result.lastInsertRowid);
        return okResult([], [], this.lastChanges, this.lastInsertRowid);
      }

      // Multi-statement scripts must use exec — prepare only binds the first statement.
      if (isMultiStatement(sql)) {
        this.db.exec(sql);
        this.refreshCountersFromSqlite();
        return okResult([], [], this.lastChanges, this.lastInsertRowid);
      }

      // Prefer prepare().run() so changes/lastInsertRowid are live for single statements.
      let stmt: ReturnType<BunDatabase["prepare"]>;
      try {
        stmt = this.db.prepare(sql);
      } catch {
        this.db.exec(sql);
        this.refreshCountersFromSqlite();
        return okResult([], [], this.lastChanges, this.lastInsertRowid);
      }
      const result = stmt.run();
      this.recordRun(result.changes, result.lastInsertRowid);
      return okResult([], [], this.lastChanges, this.lastInsertRowid);
    } catch (error) {
      return mapSqliteError(error);
    }
  }

  private refreshCountersFromSqlite(): void {
    const changesRow = this.db.query("SELECT changes() AS c").get() as { c: number } | null;
    const rowidRow = this.db.query("SELECT last_insert_rowid() AS r").get() as {
      r: number | bigint;
    } | null;
    this.lastChanges = changesRow?.c ?? 0;
    this.lastInsertRowid = rowidRow?.r ?? 0;
  }

  query(sql: string, params?: SqlValue[]): QueryResult {
    if (this.closed) return this.closedError();
    try {
      const q = this.db.prepare(sql);
      return shapeStatementResult(q, params);
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
