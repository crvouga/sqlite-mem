import { SqliteError } from "../errors/index.ts";
import { parseUnits } from "../parser/index.ts";
import {
  type Clock,
  type DatabaseOptions,
  DEFAULT_DATABASE_SEED,
  fixedClock,
  OsEntropy,
  Prng,
  type RandomMode,
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
 * (`2000-01-01T00:00:00.000Z`). Pass `{ random: "os" }` and `{ now: "system" }`
 * for SQLite-like CSPRNG and wall-clock `'now'`. There is no filesystem or WASM.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/sqlite-mem";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
 * db.prepare("INSERT INTO users (name) VALUES (?)").run("Alice");
 * const users = db.query<{ id: number; name: string }>("SELECT * FROM users");
 * ```
 */
export class Database {
  /** @internal Engine catalog, tables, and mutation counters. */
  readonly state = new DatabaseState();
  /** Seed used to construct the PRNG. Ignored when {@link randomMode} is `"os"`. */
  readonly seed: number | bigint;
  /** Entropy mode for `random()` / `randomblob()`. */
  readonly randomMode: RandomMode;
  /**
   * When true, `'now'` follows the wall clock and {@link restore} does not freeze it.
   * @internal
   */
  readonly systemClock: boolean;
  /**
   * PRNG backing `random()` / `randomblob()` and related builtins.
   * Prefer passing `seed` / `random` to the constructor.
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
  /** Depth of active {@link transaction} callbacks (not SQL BEGIN). */
  private apiTransactionDepth = 0;

  /**
   * Create an empty in-memory database.
   *
   * @param options - Determinism knobs. See {@link DatabaseOptions}.
   */
  constructor(options: DatabaseOptions = {}) {
    this.seed = options.seed ?? DEFAULT_DATABASE_SEED;
    this.randomMode = options.random ?? "deterministic";
    this.systemClock = options.now === "system";
    this.prng = this.randomMode === "os" ? new OsEntropy() : new Prng(this.seed);
    this.now = resolveClock(options.now);
    this.transactions = new TransactionManager(this.state, this.prng);
  }

  /**
   * Execute SQL for its side effects (DDL/DML). Multiple statements are allowed.
   *
   * Does not accept bind parameters — use {@link prepare} or {@link query}.
   *
   * @param sql - SQL to run (semicolon-separated statements are ok).
   * @throws {SqliteError} If the database is closed, extra arguments are passed, or the SQL fails.
   */
  exec(sql: string): void {
    this.assertOpen();
    // Runtime guard: TypeScript rejects a second argument; JS callers must still get misuse.
    // biome-ignore lint/complexity/noArguments: intentional arity check for the frozen exec(sql) signature
    if (arguments.length > 1) {
      throw new SqliteError("exec() does not accept parameters; use prepare() or query()", "misuse");
    }
    Statement.createFromSql(this, sql).run();
  }

  /**
   * Execute a single-statement query and return all rows as objects keyed by column name.
   *
   * @typeParam T - Row shape. Defaults to {@link QueryRow}.
   * @param sql - A single SQL statement (trailing `;` is fine).
   * @param params - Bound parameters for `?` / `:name` placeholders.
   * @returns All result rows.
   * @throws {SqliteError} If the database is closed, `sql` is not a single statement, or execution fails.
   */
  query<T = QueryRow>(sql: string, params: readonly BindValue[] = []): T[] {
    this.assertOpen();
    return this.prepareSingle(sql).all<T>(...params);
  }

  /**
   * Compile a single SQL statement into a reusable {@link Statement}.
   *
   * @param sql - A single SQL statement (trailing `;` is fine). Multi-statement scripts are rejected.
   * @throws {SqliteError} If the database is closed or `sql` cannot be prepared as one statement.
   */
  prepare(sql: string): Statement {
    this.assertOpen();
    return this.prepareSingle(sql);
  }

  /**
   * Run `fn` inside a transaction. Commits on success; rolls back if `fn` throws.
   *
   * Nested calls use SAVEPOINTs so an inner failure does not abort the outer
   * transaction. Calling {@link close} from inside `fn` throws `misuse`.
   *
   * @param fn - Work to run while the transaction is open.
   * @returns The value returned by `fn`.
   * @throws {SqliteError} If the database is closed. Re-throws whatever `fn` throws after rollback.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.apiTransactionDepth++;
    try {
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
    } finally {
      this.apiTransactionDepth--;
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
   * Newer library versions can restore older snapshots; older libraries cannot
   * restore newer format versions.
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
      if (!this.systemClock) this.now = fixedClock(new Date(decoded.runtime.nowMs));
    }
  }

  /**
   * Close the database. Further SQL throws {@link SqliteError}. Idempotent.
   *
   * Rolls back an open SQL transaction, if any. Throws if called from inside
   * a {@link transaction} callback.
   */
  close(): void {
    if (this.closed) return;
    if (this.apiTransactionDepth > 0) {
      throw new SqliteError("cannot close database inside transaction()", "misuse");
    }
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
   * Cumulative rows changed by INSERT / UPDATE / DELETE (SQLite `total_changes()`).
   *
   * @throws {SqliteError} If the database is closed.
   */
  get totalChanges(): number {
    this.assertOpen();
    return this.state.totalChanges;
  }

  /**
   * Throw if {@link close} has already been called.
   * @internal
   * @throws {SqliteError} If the database is closed.
   */
  assertOpen(): void {
    if (this.closed) throw new SqliteError("Database is closed", "misuse");
  }

  private prepareSingle(sql: string): Statement {
    const units = parseUnits(sql);
    if (units.length === 0) {
      throw new SqliteError("empty statement", "misuse");
    }
    if (units.length > 1) {
      throw new SqliteError("query()/prepare() accept a single statement only; use exec() for scripts", "misuse");
    }
    return Statement.create(
      this,
      sql,
      units.map((u) => u.statement),
      units.map((u) => u.sql),
    );
  }
}

const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose;
if (typeof disposeKey === "symbol") {
  Object.defineProperty(Database.prototype, disposeKey, {
    value: function (this: Database): void {
      this.close();
    },
    writable: true,
    configurable: true,
  });
}

export type { DatabaseOptions };
