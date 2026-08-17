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

export class SqliteError extends Error {
  readonly category: ErrorCategory;
  readonly sqliteCode?: string;

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
