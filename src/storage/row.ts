import type { SqlValue } from "../types/value.ts";
import { cloneSqlValue } from "../types/value.ts";

export type Rowid = number | bigint;

export interface Row {
  rowid: Rowid;
  values: Map<string, SqlValue>;
}

export type RowValues = Map<string, SqlValue> | ReadonlyMap<string, SqlValue> | Record<string, SqlValue>;

export function normalizeColumnName(name: string): string {
  return name.toLowerCase();
}

export function rowValues(values: RowValues): Map<string, SqlValue> {
  const result = new Map<string, SqlValue>();
  const entries = values instanceof Map ? values.entries() : Object.entries(values);
  for (const [name, value] of entries) {
    result.set(normalizeColumnName(name), value);
  }
  return result;
}

export function cloneRow(row: Row): Row {
  const values = new Map<string, SqlValue>();
  for (const [name, value] of row.values) {
    values.set(name, cloneSqlValue(value));
  }
  return { rowid: row.rowid, values };
}
