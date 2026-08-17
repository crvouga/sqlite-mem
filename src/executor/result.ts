import { isSqlReal, type SqlValue } from "../types/value.ts";

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

/** Export engine values to the public JS surface (SqlReal → number). */
export function exportSqlValue(value: SqlValue): SqlValue {
  return isSqlReal(value) ? value.value : value;
}

export function valuesToResult(
  columns: string[],
  values: SqlValue[][],
  changes = 0,
  lastInsertRowid: number | bigint = 0,
): ResultSet {
  return {
    columns,
    values: values.map((row) => row.map(exportSqlValue)),
    rows: values.map((row) => {
      const object: Record<string, SqlValue> = {};
      columns.forEach((name, index) => { object[name] = exportSqlValue(row[index] ?? null); });
      return object;
    }),
    changes,
    lastInsertRowid,
  };
}

export function resultValues(result: ResultSet): SqlValue[][] {
  return result.values?.map((row) => [...row])
    ?? result.rows.map((row) => result.columns.map((column) => row[column] ?? null));
}
