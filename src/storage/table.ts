import type { Expr, TableConstraint } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { Affinity, SqlValue } from "../types/value.ts";
import { affinityFromTypeName, applyAffinity, cloneSqlValue, compareSql } from "../types/value.ts";
import type { Row, Rowid, RowValues } from "./row.ts";
import { cloneRow, normalizeColumnName, rowValues } from "./row.ts";

export interface ColumnInfo {
  name: string;
  typeName: string | null;
  affinity: Affinity;
  notNull: boolean;
  primaryKey: boolean;
  autoincrement: boolean;
  defaultExpr: Expr | null;
  unique: boolean;
}

export interface InsertRow {
  rowid?: Rowid;
  values: RowValues;
}

export interface TableOptions {
  constraints?: TableConstraint[];
  indexes?: string[];
  originalSql?: string | null;
}

export class Table {
  name: string;
  columns: ColumnInfo[];
  rows: Map<Rowid, Row>;
  nextRowid: Rowid;
  constraints: TableConstraint[];
  indexes: string[];
  originalSql: string | null;

  constructor(name: string, columns: ColumnInfo[], options: TableOptions = {}) {
    this.name = name;
    this.columns = columns.map(cloneColumn);
    this.rows = new Map();
    this.nextRowid = 1;
    this.constraints = cloneAst(options.constraints ?? []);
    this.indexes = [...(options.indexes ?? [])];
    this.originalSql = options.originalSql ?? null;
  }

  insert(input: InsertRow | RowValues): Rowid {
    const supplied = isInsertRow(input) ? input : { values: input };
    const values = this.prepareValues(supplied.values);
    const alias = this.integerPrimaryKeyAlias();
    let rowid = supplied.rowid;

    if (alias) {
      const value = values.get(normalizeColumnName(alias.name)) ?? null;
      if (rowid === undefined && value !== null) rowid = asRowid(value, alias.name);
    }
    rowid = canonicalRowid(rowid ?? this.allocateRowid());

    if (this.rows.has(rowid)) {
      throw new SqliteError(`UNIQUE constraint failed: ${this.name}.rowid`, "constraint_primary", "SQLITE_CONSTRAINT_PRIMARYKEY");
    }
    if (alias) values.set(normalizeColumnName(alias.name), rowid);

    const candidate: Row = { rowid, values };
    this.validate(candidate);
    this.rows.set(rowid, candidate);
    this.advanceNextRowid(rowid);
    return rowid;
  }

  update(rowid: Rowid, updates: RowValues): void {
    const key = canonicalRowid(rowid);
    const existing = this.rows.get(key);
    if (!existing) return;

    const values = new Map(existing.values);
    const incoming = rowValues(updates);
    for (const [name, value] of incoming) {
      const column = this.column(name);
      values.set(normalizeColumnName(column.name), applyAffinity(cloneSqlValue(value), column.affinity));
    }

    const alias = this.integerPrimaryKeyAlias();
    if (alias) values.set(normalizeColumnName(alias.name), key);
    const candidate: Row = { rowid: key, values };
    this.validate(candidate, key);
    this.rows.set(key, candidate);
  }

  delete(rowid: Rowid): boolean {
    return this.rows.delete(canonicalRowid(rowid));
  }

  *scan(): Iterable<Row> {
    yield* this.rows.values();
  }

  clone(): Table {
    const copy = new Table(this.name, this.columns, {
      constraints: this.constraints,
      indexes: this.indexes,
      originalSql: this.originalSql,
    });
    copy.nextRowid = this.nextRowid;
    for (const [rowid, row] of this.rows) copy.rows.set(rowid, cloneRow(row));
    return copy;
  }

  private prepareValues(input: RowValues): Map<string, SqlValue> {
    const supplied = rowValues(input);
    for (const name of supplied.keys()) this.column(name);

    const result = new Map<string, SqlValue>();
    for (const column of this.columns) {
      const key = normalizeColumnName(column.name);
      result.set(key, applyAffinity(cloneSqlValue(supplied.get(key) ?? null), column.affinity));
    }
    return result;
  }

  private column(name: string): ColumnInfo {
    const key = normalizeColumnName(name);
    const column = this.columns.find((item) => normalizeColumnName(item.name) === key);
    if (!column) throw new SqliteError(`no such column: ${name}`, "no_such_column");
    return column;
  }

  private validate(row: Row, excludedRowid?: Rowid): void {
    for (const column of this.columns) {
      const value = row.values.get(normalizeColumnName(column.name)) ?? null;
      if ((column.notNull || column.primaryKey) && value === null) {
        const category = column.primaryKey ? "constraint_primary" : "constraint_notnull";
        const code = column.primaryKey ? "SQLITE_CONSTRAINT_PRIMARYKEY" : "SQLITE_CONSTRAINT_NOTNULL";
        throw new SqliteError(`${column.primaryKey ? "PRIMARY KEY" : "NOT NULL"} constraint failed: ${this.name}.${column.name}`, category, code);
      }
    }

    const uniqueSets = this.uniqueColumnSets();
    for (const names of uniqueSets) {
      const values = names.map((name) => row.values.get(normalizeColumnName(name)) ?? null);
      if (values.some((value) => value === null)) continue;
      for (const other of this.rows.values()) {
        if (excludedRowid !== undefined && other.rowid === excludedRowid) continue;
        if (values.every((value, index) => compareSql(value, other.values.get(normalizeColumnName(names[index]!)) ?? null) === 0)) {
          const qualified = names.map((name) => `${this.name}.${name}`).join(", ");
          throw new SqliteError(`UNIQUE constraint failed: ${qualified}`, "constraint_unique", "SQLITE_CONSTRAINT_UNIQUE");
        }
      }
    }
  }

  private uniqueColumnSets(): string[][] {
    const sets = this.columns
      .filter((column) => column.unique)
      .map((column) => [column.name]);
    if (!this.constraints.some((constraint) => constraint.type === "primary_key")) {
      const primary = this.columns.filter((column) => column.primaryKey).map((column) => column.name);
      if (primary.length > 0) sets.push(primary);
    }
    for (const constraint of this.constraints) {
      if (constraint.type === "unique" || constraint.type === "primary_key") {
        sets.push(constraint.columns.map((column) => column.name));
      }
    }
    return sets;
  }

  private integerPrimaryKeyAlias(): ColumnInfo | undefined {
    const primary = this.columns.filter((column) => column.primaryKey);
    if (primary.length !== 1 || primary[0]!.typeName?.trim().toUpperCase() !== "INTEGER") return undefined;
    return primary[0];
  }

  private allocateRowid(): Rowid {
    let candidate = canonicalRowid(this.nextRowid);
    while (this.rows.has(candidate)) candidate = incrementRowid(candidate);
    return candidate;
  }

  private advanceNextRowid(rowid: Rowid): void {
    if (compareRowids(rowid, this.nextRowid) >= 0) this.nextRowid = incrementRowid(rowid);
  }
}

export function makeColumnInfo(
  name: string,
  typeName: string | null,
  options: Partial<Omit<ColumnInfo, "name" | "typeName" | "affinity">> = {},
): ColumnInfo {
  return {
    name,
    typeName,
    affinity: affinityFromTypeName(typeName),
    notNull: options.notNull ?? false,
    primaryKey: options.primaryKey ?? false,
    autoincrement: options.autoincrement ?? false,
    defaultExpr: options.defaultExpr ?? null,
    unique: options.unique ?? false,
  };
}

function cloneColumn(column: ColumnInfo): ColumnInfo {
  return {
    ...column,
    defaultExpr: column.defaultExpr === null ? null : cloneAst(column.defaultExpr),
  };
}

function cloneAst<T>(value: T): T {
  return structuredClone(value);
}

function isInsertRow(input: InsertRow | RowValues): input is InsertRow {
  return !(input instanceof Map) && "values" in input;
}

function asRowid(value: SqlValue, column: string): Rowid {
  if (typeof value === "bigint") return canonicalRowid(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new SqliteError(`datatype mismatch for INTEGER PRIMARY KEY column: ${column}`, "datatype_mismatch", "SQLITE_MISMATCH");
}

function canonicalRowid(value: Rowid): Rowid {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new SqliteError("rowid must be a safe integer or bigint", "datatype_mismatch", "SQLITE_MISMATCH");
    return value;
  }
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  return value;
}

function incrementRowid(value: Rowid): Rowid {
  if (typeof value === "bigint") return value + 1n;
  if (value < Number.MAX_SAFE_INTEGER) return value + 1;
  return BigInt(value) + 1n;
}

function compareRowids(left: Rowid, right: Rowid): number {
  const a = typeof left === "bigint" ? left : BigInt(left);
  const b = typeof right === "bigint" ? right : BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
