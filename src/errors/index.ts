/** Coarse classification of {@link SqliteError} for catch-site branching. */
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

/**
 * Engine error. `name` is always `"SqliteError"`.
 *
 * @example
 * ```ts
 * import { Database, SqliteError } from "@crvouga/sqlite-mem";
 *
 * const db = new Database();
 * try {
 *   db.exec("SELECT * FROM missing");
 * } catch (err) {
 *   if (err instanceof SqliteError && err.category === "no_such_table") {
 *     // handle
 *   }
 * }
 * ```
 */
export class SqliteError extends Error {
  /** Coarse error class (constraint vs syntax vs missing object, …). */
  readonly category: ErrorCategory;
  /** Optional SQLite result-code name such as `SQLITE_CONSTRAINT`. */
  readonly sqliteCode?: string;

  /**
   * @param message - Human-readable error text.
   * @param category - Coarse class; defaults to `"other"`.
   * @param sqliteCode - Optional SQLite result-code name.
   */
  constructor(message: string, category: ErrorCategory = "other", sqliteCode?: string) {
    super(message);
    this.name = "SqliteError";
    this.category = category;
    this.sqliteCode = sqliteCode;
  }
}

export function unsupported(feature: string): never {
  throw new SqliteError(`Unsupported SQLite feature: ${feature}`, "unsupported");
}

export class TriggerRaiseError extends SqliteError {
  readonly action: "IGNORE" | "ABORT" | "FAIL" | "ROLLBACK";

  constructor(action: "IGNORE" | "ABORT" | "FAIL" | "ROLLBACK", message?: string) {
    super(
      message ?? action,
      action === "FAIL" ? "constraint" : "other",
      action === "FAIL" ? "SQLITE_CONSTRAINT" : undefined,
    );
    this.action = action;
  }
}
