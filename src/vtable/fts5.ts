import { SqliteError } from "../errors/index.ts";
import type { Rowid } from "../storage/row.ts";
import type { SqlValue } from "../types/value.ts";

export interface Fts5Row {
  rowid: Rowid;
  values: Map<string, SqlValue>;
  tokensByColumn: Map<string, Set<string>>;
}

export function tokenizeFtsText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export class Fts5VirtualTable {
  readonly kind: "fts5" | "fts3" | "fts4";
  readonly name: string;
  readonly columns: string[];
  readonly originalSql: string | null;
  readonly rows = new Map<Rowid, Fts5Row>();
  nextRowid: Rowid = 1;

  constructor(
    name: string,
    columns: string[],
    originalSql: string | null = null,
    kind: "fts5" | "fts3" | "fts4" = "fts5",
  ) {
    if (columns.length === 0) throw new SqliteError("fts requires at least one column", "other");
    this.kind = kind;
    this.name = name;
    this.columns = columns.map((column) => column);
    this.originalSql = originalSql;
  }

  scan(): Fts5Row[] {
    return [...this.rows.values()];
  }

  insert(values: Map<string, SqlValue>, rowid?: Rowid): Rowid {
    const assigned = rowid ?? this.nextRowid++;
    if (this.rows.has(assigned)) throw new SqliteError("PRIMARY KEY constraint failed", "constraint_primary");
    const row = this.buildRow(assigned, values);
    this.rows.set(assigned, row);
    if (typeof assigned === "bigint") {
      if (assigned >= BigInt(this.nextRowid as number | bigint)) this.nextRowid = assigned + 1n;
    } else if (assigned >= (typeof this.nextRowid === "number" ? this.nextRowid : Number(this.nextRowid))) {
      this.nextRowid = assigned + 1;
    }
    return assigned;
  }

  update(rowid: Rowid, updates: Map<string, SqlValue>): void {
    const row = this.rows.get(rowid);
    if (!row) return;
    const values = new Map(row.values);
    for (const [key, value] of updates) values.set(key, value);
    this.rows.set(rowid, this.buildRow(rowid, values));
  }

  delete(rowid: Rowid): void {
    this.rows.delete(rowid);
  }

  matches(rowid: Rowid, leftTable: string | null, leftColumn: string, query: string): boolean {
    const row = this.rows.get(rowid);
    if (!row) return false;
    const queryTokens = tokenizeFtsText(query);
    if (queryTokens.length === 0) return true;

    const columnLower = leftColumn.toLowerCase();
    const tableLower = this.name.toLowerCase();
    const leftTableLower = leftTable?.toLowerCase() ?? null;
    const searchColumns = this.resolveSearchColumns(columnLower, leftTableLower, tableLower);

    const indexed = new Set<string>();
    for (const column of searchColumns) {
      for (const token of row.tokensByColumn.get(column.toLowerCase()) ?? []) indexed.add(token);
    }
    return queryTokens.every((token) => indexed.has(token));
  }

  clone(): Fts5VirtualTable {
    const copy = new Fts5VirtualTable(this.name, this.columns, this.originalSql, this.kind);
    copy.nextRowid = this.nextRowid;
    for (const [rowid, row] of this.rows) {
      copy.rows.set(rowid, {
        rowid: row.rowid,
        values: new Map(row.values),
        tokensByColumn: new Map([...row.tokensByColumn.entries()].map(([key, tokens]) => [key, new Set(tokens)])),
      });
    }
    return copy;
  }

  private resolveSearchColumns(columnLower: string, leftTableLower: string | null, tableLower: string): string[] {
    if (columnLower === tableLower) return this.columns;
    if (leftTableLower !== null && columnLower === leftTableLower) return this.columns;
    const matched = this.columns.find((column) => column.toLowerCase() === columnLower);
    if (matched) return [matched];
    return [];
  }

  private buildRow(rowid: Rowid, values: Map<string, SqlValue>): Fts5Row {
    const stored = new Map<string, SqlValue>();
    const tokensByColumn = new Map<string, Set<string>>();
    for (const column of this.columns) {
      const key = column.toLowerCase();
      const value = values.get(key) ?? null;
      stored.set(key, value);
      tokensByColumn.set(key, new Set(tokenizeFtsText(value === null ? "" : String(value))));
    }
    return { rowid, values: stored, tokensByColumn };
  }
}
