import { SqliteError } from "../errors/index.ts";
import { DatabaseState } from "../storage/database-state.ts";
import { TransactionManager } from "../transactions/manager.ts";
import { parse } from "../parser/index.ts";
import { decodeDatabaseState, encodeDatabaseState } from "../serialization/codec.ts";
import {
  DEFAULT_DATABASE_SEED,
  resolveClock,
  Prng,
  type Clock,
  type DatabaseOptions,
} from "../runtime/index.ts";
import { Statement } from "./statement.ts";

export class Database {
  readonly state = new DatabaseState();
  readonly transactions = new TransactionManager(this.state);
  readonly seed: number | bigint;
  readonly prng: Prng;
  readonly now: Clock;
  private closed = false;
  private transactionSequence = 0;

  constructor(options: DatabaseOptions = {}) {
    this.seed = options.seed ?? DEFAULT_DATABASE_SEED;
    this.prng = options.prng ?? new Prng(this.seed);
    this.now = resolveClock(options.now);
  }

  exec(sql: string, params: unknown[] = []): void {
    this.assertOpen();
    new Statement(this, sql, parse(sql)).run(...params);
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    this.assertOpen();
    return new Statement(this, sql, parse(sql)).all<T>(...params);
  }

  prepare(sql: string): Statement {
    this.assertOpen();
    return new Statement(this, sql, parse(sql));
  }

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

  snapshot(): Uint8Array {
    this.assertOpen();
    return encodeDatabaseState(this.state);
  }

  restore(snapshot: Uint8Array): void {
    this.assertOpen();
    if (this.transactions.inTransaction) throw new SqliteError("cannot restore during a transaction", "transaction");
    this.state.replaceWith(decodeDatabaseState(snapshot));
  }

  close(): void {
    if (this.closed) return;
    if (this.transactions.inTransaction) this.transactions.rollback();
    this.closed = true;
  }

  get changes(): number {
    this.assertOpen();
    return this.state.changes;
  }

  get lastInsertRowid(): number | bigint {
    this.assertOpen();
    return this.state.lastInsertRowid;
  }

  assertOpen(): void {
    if (this.closed) throw new SqliteError("Database is closed", "misuse");
  }
}

export type { DatabaseOptions };
