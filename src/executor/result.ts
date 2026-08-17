import type { SqlValue } from "../types/value.ts";

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

export function valuesToResult(
  columns: string[],
  values: SqlValue[][],
  changes = 0,
  lastInsertRowid: number | bigint = 0,
): ResultSet {
  return {
    columns,
    values: values.map((row) => [...row]),
    rows: values.map((row) => {
      const object: Record<string, SqlValue> = {};
      columns.forEach((name, index) => { object[name] = row[index] ?? null; });
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
