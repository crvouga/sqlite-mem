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
