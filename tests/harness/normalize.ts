import type { ErrorCategory, NormalizedResult, NormalizedValue, QueryResult, SqlValue } from "./types.ts";

export function normalizeValue(value: SqlValue): NormalizedValue {
  if (value === null) return { kind: "null" };
  if (value instanceof Uint8Array) return { kind: "blob", value: new Uint8Array(value) };
  if (typeof value === "string") return { kind: "text", value };
  if (typeof value === "bigint") return { kind: "integer", value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { kind: "integer", value } : { kind: "real", value };
  }
  // SqlReal / SqlJsonText and similar wrappers
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "number") {
      return Number.isInteger(inner) ? { kind: "integer", value: inner } : { kind: "real", value: inner };
    }
    if (typeof inner === "string") return { kind: "text", value: inner };
  }
  return { kind: "text", value: String(value) };
}

export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/^(SQLiteError|SqliteError):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize error messages for differential comparison.
 * Keeps category-defining prefixes; strips engine-specific detail that SQLite
 * versions legitimately vary on (column lists after UNIQUE/CHECK, etc.).
 */
export function normalizeErrorMessageForCompare(message: string): string {
  const msg = normalizeErrorMessage(message);
  const lower = msg.toLowerCase();

  if (lower.startsWith("unique constraint failed")) {
    return "UNIQUE constraint failed";
  }
  if (lower.startsWith("primary key constraint failed")) {
    return "PRIMARY KEY constraint failed";
  }
  if (lower.startsWith("not null constraint failed")) {
    return "NOT NULL constraint failed";
  }
  if (lower.startsWith("check constraint failed")) {
    return "CHECK constraint failed";
  }
  if (lower.startsWith("foreign key constraint failed")) {
    return "FOREIGN KEY constraint failed";
  }
  if (lower.includes("cannot store") && lower.includes("column")) {
    return "cannot store value in STRICT column";
  }
  if (lower.startsWith("unknown datatype")) {
    return "unknown datatype";
  }
  if (/selects to the left and right of .+ do not have the same number of result columns/.test(lower)) {
    return "compound select column count mismatch";
  }
  if (lower.startsWith("cannot drop primary key") || lower.startsWith("cannot drop column")) {
    return "cannot drop column";
  }
  if (lower.startsWith("no such column")) {
    return "no such column";
  }
  if (lower.startsWith("no such table")) {
    return "no such table";
  }
  if (lower.startsWith("datatype mismatch")) {
    return "datatype mismatch";
  }
  return msg;
}

export function categorizeErrorMessage(message: string): ErrorCategory {
  const msg = normalizeErrorMessage(message).toLowerCase();

  if (/syntax error|near "[^"]+"|incomplete input|unrecognized token|unterminated/.test(msg)) {
    return "syntax";
  }
  if (/no such table/.test(msg)) return "no_such_table";
  if (/no such column/.test(msg)) return "no_such_column";
  if (/unique constraint failed/.test(msg)) return "constraint_unique";
  if (/primary key constraint failed/.test(msg)) return "constraint_primary";
  if (/not null constraint failed/.test(msg)) return "constraint_notnull";
  if (/check constraint failed/.test(msg)) return "constraint_check";
  if (/foreign key constraint failed/.test(msg)) return "constraint_foreign";
  if (/constraint failed/.test(msg)) return "constraint";
  if (/cannot start a transaction|cannot commit|cannot rollback|no transaction is active/.test(msg)) {
    return "transaction";
  }
  if (/cannot store .+ value in .+ column/.test(msg)) return "datatype_mismatch";
  if (/unknown datatype/.test(msg)) return "other";
  if (/datatype mismatch|type mismatch/.test(msg)) return "datatype_mismatch";
  if (/unsupported|not supported|not yet implemented/.test(msg)) return "unsupported";
  if (/misuse|bad parameter|api misuse|expected \d+ values, received/.test(msg)) return "misuse";

  return "other";
}

export function normalizeError(
  message: string,
  category?: ErrorCategory,
): { category: ErrorCategory; message: string } {
  const normalizedMessage = normalizeErrorMessage(message);
  return {
    category: category ?? categorizeErrorMessage(normalizedMessage),
    message: normalizedMessage,
  };
}

export function normalizeQueryResult(result: QueryResult): NormalizedResult {
  const valueRows = result.values;
  const columns = [...result.columns];
  const rows =
    valueRows && (valueRows.length > 0 || columns.length > 0)
      ? valueRows.map((row) => row.map((value) => normalizeValue(value)))
      : result.rows.map((row) => columns.map((column) => normalizeValue(row[column] ?? null)));

  const normalized: NormalizedResult = {
    ok: result.ok,
    columns,
    rows: result.ok ? rows : [],
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
  };

  if (result.error) {
    normalized.error = normalizeError(result.error.message, result.error.category);
  }

  return normalized;
}

export interface ValuesEqualOptions {
  /** When true, number and bigint representing the same integer are equal. */
  rowid?: boolean;
}

export function valuesEqual(a: SqlValue, b: SqlValue, options: ValuesEqualOptions = {}): boolean {
  if (a === null || b === null) return a === b;

  if (typeof a === "number" && typeof b === "number") {
    if (options.rowid && Number.isInteger(a) && Number.isInteger(b)) {
      return BigInt(a) === BigInt(b);
    }
    return Object.is(a, b);
  }

  if (a === b) return true;

  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false;

  if (typeof a === "string" || typeof b === "string") {
    return typeof a === "string" && typeof b === "string" && a === b;
  }

  const aIsInt = typeof a === "bigint" || (typeof a === "number" && Number.isInteger(a));
  const bIsInt = typeof b === "bigint" || (typeof b === "number" && Number.isInteger(b));

  if (options.rowid && aIsInt && bIsInt) {
    try {
      return BigInt(a as number | bigint) === BigInt(b as number | bigint);
    } catch {
      return false;
    }
  }

  if (typeof a === "bigint" && typeof b === "bigint") {
    return a === b;
  }

  return false;
}

function normalizedValuesEqual(a: NormalizedValue, b: NormalizedValue, rowid = false, realEpsilon?: number): boolean {
  if (a.kind !== b.kind) {
    if (rowid && a.kind === "integer" && b.kind === "integer") {
      try {
        return BigInt(a.value) === BigInt(b.value);
      } catch {
        return false;
      }
    }
    return false;
  }

  switch (a.kind) {
    case "null":
      return true;
    case "integer":
      try {
        return BigInt(a.value) === BigInt((b as Extract<NormalizedValue, { kind: "integer" }>).value);
      } catch {
        return false;
      }
    case "real": {
      const av = a.value;
      const bv = (b as Extract<NormalizedValue, { kind: "real" }>).value;
      if (Object.is(av, bv)) return true;
      if (realEpsilon !== undefined && Number.isFinite(av) && Number.isFinite(bv)) {
        return Math.abs(av - bv) <= realEpsilon;
      }
      return false;
    }
    case "text":
      return a.value === (b as Extract<NormalizedValue, { kind: "text" }>).value;
    case "blob": {
      const bb = b as Extract<NormalizedValue, { kind: "blob" }>;
      if (a.value.length !== bb.value.length) return false;
      for (let i = 0; i < a.value.length; i++) {
        if (a.value[i] !== bb.value[i]) return false;
      }
      return true;
    }
  }
}

function positionalRowsEqual(a: NormalizedResult, b: NormalizedResult, realEpsilon?: number): boolean {
  if (a.rows.length !== b.rows.length) return false;
  for (let r = 0; r < a.rows.length; r++) {
    const rowA = a.rows[r]!;
    const rowB = b.rows[r]!;
    if (rowA.length !== rowB.length) return false;
    for (let c = 0; c < rowA.length; c++) {
      const colName = a.columns[c] ?? b.columns[c] ?? "";
      const isRowid = colName.toLowerCase().includes("rowid") || colName.toLowerCase() === "oid";
      if (!normalizedValuesEqual(rowA[c]!, rowB[c]!, isRowid, realEpsilon)) return false;
    }
  }
  return true;
}

export interface CompareOptions {
  /**
   * Absolute epsilon for REAL comparisons (FTS bm25/rank ULP noise only).
   * Default: exact Object.is. Do not enable for general SQL parity.
   */
  realEpsilon?: number;
}

export function deepCompareResults(
  a: QueryResult,
  b: QueryResult,
  options?: CompareOptions,
): { equal: boolean; reason?: string } {
  const na = normalizeQueryResult(a);
  const nb = normalizeQueryResult(b);
  const realEpsilon = options?.realEpsilon;

  if (na.ok !== nb.ok) {
    return { equal: false, reason: `ok mismatch: ${na.ok} vs ${nb.ok}` };
  }

  if (!na.ok || !nb.ok) {
    const ea = na.error;
    const eb = nb.error;
    if (!ea || !eb) {
      return { equal: false, reason: "error metadata mismatch" };
    }
    if (ea.category !== eb.category) {
      return {
        equal: false,
        reason: `error category mismatch: ${ea.category} vs ${eb.category}`,
      };
    }
    const ma = normalizeErrorMessageForCompare(ea.message);
    const mb = normalizeErrorMessageForCompare(eb.message);
    if (ma !== mb) {
      return {
        equal: false,
        reason: `error message mismatch:\n  a: ${ea.message}\n  b: ${eb.message}`,
      };
    }
    return { equal: true };
  }

  if (na.columns.length !== nb.columns.length) {
    // bun:sqlite may collapse duplicate headers or keep stale prepared columnNames after
    // ALTER while values() still returns the full width. Prefer positional values.
    if (!positionalRowsEqual(na, nb, realEpsilon)) {
      return { equal: false, reason: "column count mismatch" };
    }
  } else {
    for (let i = 0; i < na.columns.length; i++) {
      if (na.columns[i] !== nb.columns[i]) {
        return {
          equal: false,
          reason: `column name mismatch at ${i}: ${na.columns[i]} vs ${nb.columns[i]}`,
        };
      }
    }
  }

  if (na.rows.length !== nb.rows.length) {
    return { equal: false, reason: `row count mismatch: ${na.rows.length} vs ${nb.rows.length}` };
  }

  for (let r = 0; r < na.rows.length; r++) {
    const rowA = na.rows[r]!;
    const rowB = nb.rows[r]!;
    const width = Math.max(rowA.length, rowB.length);
    if (rowA.length !== rowB.length) {
      return { equal: false, reason: `value width mismatch at row ${r}` };
    }
    for (let c = 0; c < width; c++) {
      const colName = na.columns[c] ?? nb.columns[c] ?? `column ${c}`;
      const isRowid = colName.toLowerCase().includes("rowid") || colName.toLowerCase() === "oid";
      if (!normalizedValuesEqual(rowA[c]!, rowB[c]!, isRowid, realEpsilon)) {
        return {
          equal: false,
          reason: `value mismatch at row ${r}, column ${colName}`,
        };
      }
    }
  }

  if (na.changes !== nb.changes) {
    return { equal: false, reason: `changes mismatch: ${na.changes} vs ${nb.changes}` };
  }

  if (
    !normalizedValuesEqual(
      { kind: "integer", value: na.lastInsertRowid },
      { kind: "integer", value: nb.lastInsertRowid },
      true,
    )
  ) {
    return {
      equal: false,
      reason: `lastInsertRowid mismatch: ${String(na.lastInsertRowid)} vs ${String(nb.lastInsertRowid)}`,
    };
  }

  return { equal: true };
}
