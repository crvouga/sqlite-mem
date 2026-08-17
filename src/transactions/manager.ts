import { SqliteError } from "../errors/index.ts";
import type { DatabaseState } from "../storage/database-state.ts";

interface SavepointSnapshot {
  name: string;
  state: DatabaseState;
}

export class TransactionManager {
  readonly state: DatabaseState;
  private transactionSnapshot: DatabaseState | null = null;
  private savepoints: SavepointSnapshot[] = [];
  private startedBySavepoint = false;

  constructor(state: DatabaseState) {
    this.state = state;
  }

  get inTransaction(): boolean {
    return this.transactionSnapshot !== null;
  }

  begin(): void {
    if (this.inTransaction) {
      throw new SqliteError("cannot start a transaction within a transaction", "transaction", "SQLITE_ERROR");
    }
    this.transactionSnapshot = this.state.clone();
    this.savepoints = [];
    this.startedBySavepoint = false;
  }

  commit(): void {
    this.requireTransaction("cannot commit - no transaction is active");
    this.transactionSnapshot = null;
    this.savepoints = [];
    this.startedBySavepoint = false;
  }

  rollback(savepoint?: string): void {
    this.requireTransaction("cannot rollback - no transaction is active");
    if (savepoint !== undefined) {
      const index = this.findSavepoint(savepoint);
      const snapshot = this.savepoints[index];
      if (!snapshot) throw new SqliteError(`no such savepoint: ${savepoint}`, "transaction", "SQLITE_ERROR");
      this.state.replaceWith(snapshot.state);
      this.savepoints.splice(index + 1);
      return;
    }

    const snapshot = this.transactionSnapshot;
    if (!snapshot) throw new SqliteError("cannot rollback - no transaction is active", "transaction", "SQLITE_ERROR");
    this.state.replaceWith(snapshot);
    this.transactionSnapshot = null;
    this.savepoints = [];
    this.startedBySavepoint = false;
  }

  savepoint(name: string): void {
    if (!this.inTransaction) {
      this.transactionSnapshot = this.state.clone();
      this.startedBySavepoint = true;
    }
    this.savepoints.push({ name, state: this.state.clone() });
  }

  release(name: string): void {
    this.requireTransaction("cannot release savepoint - no transaction is active");
    const index = this.findSavepoint(name);
    this.savepoints.splice(index);
    if (this.startedBySavepoint && this.savepoints.length === 0) {
      this.transactionSnapshot = null;
      this.startedBySavepoint = false;
    }
  }

  private findSavepoint(name: string): number {
    const normalized = name.toLowerCase();
    for (let index = this.savepoints.length - 1; index >= 0; index--) {
      const savepoint = this.savepoints[index];
      if (savepoint && savepoint.name.toLowerCase() === normalized) return index;
    }
    throw new SqliteError(`no such savepoint: ${name}`, "transaction", "SQLITE_ERROR");
  }

  private requireTransaction(message: string): void {
    if (!this.inTransaction) throw new SqliteError(message, "transaction", "SQLITE_ERROR");
  }
}
