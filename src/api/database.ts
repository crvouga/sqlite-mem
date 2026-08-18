import { SqliteError } from "../errors/index.ts";
import { parse } from "../parser/index.ts";
import {
  type Clock,
  type DatabaseOptions,
  DEFAULT_DATABASE_SEED,
  fixedClock,
  Prng,
  resolveClock,
} from "../runtime/index.ts";
import { decodeDatabaseState, encodeDatabaseState } from "../serialization/codec.ts";
import { DatabaseState } from "../storage/database-state.ts";
import { TransactionManager } from "../transactions/manager.ts";
import type { BindValue, QueryRow } from "../types/value.ts";
import { Statement } from "./statement.ts";

/**
 * Pure TypeScript in-memory SQLite database.
 *
 * Deterministic by default: `random()` / `randomblob()` use a seeded PRNG
 * (`seed` defaults to `1`) and `date('now')` / friends use a fixed clock
 * (`2000-01-01T00:00:00.000Z`). There is no filesystem or WASM.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/sqlite-mem";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
 * db.exec("INSERT INTO users (name) VALUES (?)", ["Alice"]);
 * const users = db.query<{ id: number; name: string }>("SELECT * FROM users");
 * ```
 */
export class Database {
  /** @internal Engine catalog, tables, and mutation counters. */
  readonly state = new DatabaseState();
  /** Seed used to construct the PRNG when `options.prng` is omitted. */
  readonly seed: number | bigint;
  /**
   * PRNG backing `random()` / `randomblob()` and related builtins.
   * Prefer passing `seed` or `prng` to the constructor.
   * @internal
   */
  readonly prng: Prng;
  /**
   * Clock used by `date('now')` / `datetime('now')` / `CURRENT_TIMESTAMP`.
   * Prefer passing `now` to the constructor.
   * @internal
   */
  now: Clock;
  /** @internal Transaction / savepoint manager. */
  readonly transactions: TransactionManager;
  private closed = false;
  private transactionSequence = 0;

  /**
   * Create an empty in-memory database.
   *
   * @param options - Determinism knobs. See {@link DatabaseOptions}.
   */
  constructor(options: DatabaseOptions = {}) {
    this.seed = options.seed ?? DEFAULT_DATABASE_SEED;
    this.prng = options.prng ?? new Prng(this.seed);
    this.now = resolveClock(options.now);
    this.transactions = new TransactionManager(this.state, this.prng);
  }

  /**
   * Execute SQL for its side effects (DDL/DML). Multiple statements are allowed.
   *
   * @param sql - SQL to run (semicolon-separated statements are ok).
   * @param params - Bound parameters for `?` / `:name` placeholders.
   * @throws {SqliteError} If the database is closed or the SQL fails.
   */
  exec(sql: string, params: readonly BindValue[] = []): void {
    this.assertOpen();
    Statement.create(this, sql, parse(sql)).run(...params);
  }

  /**
   * Execute a query and return all rows as objects keyed by column name.
   *
   * @typeParam T - Row shape. Defaults to {@link QueryRow}.
   * @param sql - SQL SELECT (or any statement that produces a result set).
   * @param params - Bound parameters for `?` / `:name` placeholders.
   * @returns All result rows.
   * @throws {SqliteError} If the database is closed or the SQL fails.
   */
  query<T = QueryRow>(sql: string, params: readonly BindValue[] = []): T[] {
    this.assertOpen();
    return Statement.create(this, sql, parse(sql)).all<T>(...params);
  }

  /**
   * Compile `sql` into a reusable {@link Statement}.
   *
   * @param sql - SQL to prepare.
   * @throws {SqliteError} If the database is closed or `sql` cannot be parsed.
   */
  prepare(sql: string): Statement {
    this.assertOpen();
    return Statement.create(this, sql, parse(sql));
  }

  /**
   * Run `fn` inside a transaction. Commits on success; rolls back if `fn` throws.
   *
   * Nested calls use SAVEPOINTs so an inner failure does not abort the outer
   * transaction.
   *
   * @param fn - Work to run while the transaction is open.
   * @returns The value returned by `fn`.
   * @throws {SqliteError} If the database is closed. Re-throws whatever `fn` throws after rollback.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    if (!this.transactions.inTransaction) {
      this.transactions.begin();
      try {
        const value = fn();
        this.transactions.commit();
        return value;
      } catch (error) {
        this.transactions.rollback();
        throw error;
      }
    }
    const name = `__api_transaction_${++this.transactionSequence}`;
    this.transactions.savepoint(name);
    try {
      const value = fn();
      this.transactions.release(name);
      return value;
    } catch (error) {
      this.transactions.rollback(name);
      this.transactions.release(name);
      throw error;
    }
  }

  /**
   * Serialize schema, rows, PRNG state, and clock into a custom snapshot blob.
   *
   * This is not a `.sqlite` file. Restore it with {@link restore}.
   *
   * @throws {SqliteError} If the database is closed.
   */
  snapshot(): Uint8Array {
    this.assertOpen();
    return encodeDatabaseState(this.state, {
      prngState: this.prng.getState(),
      nowMs: this.now().getTime(),
    });
  }

  /**
   * Replace this database's contents with a blob from {@link snapshot}.
   *
   * Restores PRNG state and the clock when the snapshot includes them (v2).
   *
   * @param snapshot - Bytes previously returned by {@link snapshot}.
   * @throws {SqliteError} If the database is closed, a transaction is open, or the blob is invalid.
   */
  restore(snapshot: Uint8Array): void {
    this.assertOpen();
    if (this.transactions.inTransaction) throw new SqliteError("cannot restore during a transaction", "transaction");
    // Drop live state before decode so peak ≈ snapshot bytes + one decoded tree
    // (not old DB + decoded + snapshot).
    this.state.replaceWith(new DatabaseState(), { adopt: true });
    const decoded = decodeDatabaseState(snapshot);
    this.state.replaceWith(decoded.state, { adopt: true });
    if (decoded.runtime) {
      this.prng.setState(decoded.runtime.prngState);
      this.now = fixedClock(new Date(decoded.runtime.nowMs));
    }
  }

  /**
   * Close the database. Further SQL throws {@link SqliteError}. Idempotent.
   *
   * Rolls back an open transaction, if any.
   */
  close(): void {
    if (this.closed) return;
    if (this.transactions.inTransaction) this.transactions.rollback();
    this.closed = true;
  }

  /**
   * Rows changed by the most recent INSERT / UPDATE / DELETE (SQLite `changes()`).
   *
   * @throws {SqliteError} If the database is closed.
   */
  get changes(): number {
    this.assertOpen();
    return this.state.changes;
  }

  /**
   * Rowid of the most recent INSERT (SQLite `last_insert_rowid()`).
   *
   * @throws {SqliteError} If the database is closed.
   */
  get lastInsertRowid(): number | bigint {
    this.assertOpen();
    return this.state.lastInsertRowid;
  }

  /**
   * Throw if {@link close} has already been called.
   * @internal
   * @throws {SqliteError} If the database is closed.
   */
  assertOpen(): void {
    if (this.closed) throw new SqliteError("Database is closed", "misuse");
  }
}

export type { DatabaseOptions };
