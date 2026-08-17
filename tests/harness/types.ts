export type SqlValue = null | number | bigint | string | Uint8Array;

export type ErrorCategory =
  | "syntax"
  | "no_such_table"
  | "no_such_column"
  | "constraint_unique"
  | "constraint_primary"
  | "constraint_notnull"
  | "constraint_check"
  | "constraint_foreign"
  | "constraint"
  | "transaction"
  | "datatype_mismatch"
  | "unsupported"
  | "misuse"
  | "other";

export interface QueryResult {
  ok: boolean;
  columns: string[];
  rows: Record<string, SqlValue>[];
  /** Positional row values; preferred for comparison when duplicate column names exist. */
  values?: SqlValue[][];
  changes: number;
  lastInsertRowid: number | bigint;
  error?: { category: ErrorCategory; message: string };
}

export interface ContractStatement {
  bind(...params: SqlValue[]): ContractStatement;
  run(...params: SqlValue[]): QueryResult;
  all(...params: SqlValue[]): QueryResult;
  get(...params: SqlValue[]): QueryResult;
}

export interface ContractDb {
  exec(sql: string, params?: SqlValue[]): QueryResult;
  query(sql: string, params?: SqlValue[]): QueryResult;
  prepare(sql: string): ContractStatement;
  transaction<T>(fn: () => T): T;
  snapshot(): Uint8Array;
  restore(bytes: Uint8Array): void;
  close(): void;
}

export type NormalizedValue =
  | { kind: "null" }
  | { kind: "integer"; value: number | bigint }
  | { kind: "real"; value: number }
  | { kind: "text"; value: string }
  | { kind: "blob"; value: Uint8Array };

export interface NormalizedResult {
  ok: boolean;
  columns: string[];
  rows: NormalizedValue[][];
  changes: number;
  lastInsertRowid: number | bigint;
  error?: { category: ErrorCategory; message: string };
}
