import { isSqlJsonText, isSqlReal, type SqlValue } from "../types/value.ts";

export interface ResultSet {
  columns: string[];
  rows: Record<string, SqlValue>[];
  /** Positional rows preserve duplicate result-column names for internal use. */
  values?: SqlValue[][];
  changes: number;
  lastInsertRowid: number | bigint;
}

export function emptyResult(changes = 0, lastInsertRowid: number | bigint = 0): ResultSet {
  return { columns: [], rows: [], changes, lastInsertRowid };
}

/** Export engine values to the public JS surface (SqlReal → number, SqlJsonText → string). */
export function exportSqlValue(value: SqlValue): SqlValue {
  if (isSqlReal(value)) return value.value;
  if (isSqlJsonText(value)) return value.value;
  return value;
}

export function valuesToResult(
  columns: string[],
  values: SqlValue[][],
  changes = 0,
  lastInsertRowid: number | bigint = 0,
  options?: { named?: boolean; keepValues?: boolean },
): ResultSet {
  const named = options?.named !== false;
  const keepValues = options?.keepValues !== false;
  return {
    columns,
    values: keepValues ? values.map((row) => row.map(exportSqlValue)) : undefined,
    rows: named
      ? values.map((row) => {
          const object: Record<string, SqlValue> = {};
          for (let index = 0; index < columns.length; index++) {
            object[columns[index]!] = exportSqlValue(row[index] ?? null);
          }
          return object;
        })
      : [],
    changes,
    lastInsertRowid,
  };
}

export function resultValues(result: ResultSet): SqlValue[][] {
  return (
    result.values?.map((row) => [...row]) ??
    result.rows.map((row) => result.columns.map((column) => row[column] ?? null))
  );
}
