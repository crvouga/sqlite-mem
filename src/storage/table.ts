import type { Expr, TableConstraint } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { compareWithCollation, normalizeForCollation } from "../types/collation.ts";
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
  /** Declared column collation (BINARY/NOCASE/RTRIM); null means BINARY. */
  collate: string | null;
  /** GENERATED ALWAYS AS (...) — VIRTUAL computed on read, STORED materialized. */
  generated: { expr: Expr; stored: boolean } | null;
}

export interface InsertRow {
  rowid?: Rowid;
  values: RowValues;
}

export interface TableOptions {
  constraints?: TableConstraint[];
  indexes?: string[];
  originalSql?: string | null;
  withoutRowid?: boolean;
}

export class Table {
  name: string;
  columns: ColumnInfo[];
  rows: Map<Rowid, Row>;
  nextRowid: Rowid;
  constraints: TableConstraint[];
  indexes: string[];
  originalSql: string | null;
  withoutRowid: boolean;
  /** Clustered PK key string → row for WITHOUT ROWID tables. */
  clusteredRows: Map<string, Row>;

  constructor(name: string, columns: ColumnInfo[], options: TableOptions = {}) {
    this.name = name;
    this.columns = columns.map(cloneColumn);
    this.rows = new Map();
    this.nextRowid = 1;
    this.constraints = cloneAst(options.constraints ?? []);
    this.indexes = [...(options.indexes ?? [])];
    this.originalSql = options.originalSql ?? null;
    this.withoutRowid = options.withoutRowid ?? false;
    this.clusteredRows = new Map();
  }

  insert(input: InsertRow | RowValues): Rowid {
    const supplied = isInsertRow(input) ? input : { values: input };
    const values = this.prepareValues(supplied.values);

    if (this.withoutRowid) {
      if (supplied.rowid !== undefined) {
        throw new SqliteError(`table ${this.name} has no column named rowid`, "other");
      }
      const rowid = canonicalRowid(this.allocateRowid());
      const candidate: Row = { rowid, values };
      this.validate(candidate);
      const clusterKey = this.makeClusterKey(values);
      if (this.clusteredRows.has(clusterKey)) {
        throw primaryKeyConflict(this.name, this.primaryKeyColumns());
      }
      this.clusteredRows.set(clusterKey, candidate);
      this.rows.set(rowid, candidate);
      this.advanceNextRowid(rowid);
      return rowid;
    }

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

  update(rowid: Rowid, updates: RowValues): Row | undefined {
    const key = canonicalRowid(rowid);
    const existing = this.rows.get(key);
    if (!existing) return undefined;

    const values = new Map(existing.values);
    const incoming = rowValues(updates);
    for (const [name, value] of incoming) {
      const column = this.column(name);
      values.set(normalizeColumnName(column.name), applyAffinity(cloneSqlValue(value), column.affinity));
    }

    if (this.withoutRowid) {
      const oldClusterKey = this.makeClusterKey(existing.values);
      const newClusterKey = this.makeClusterKey(values);
      if (newClusterKey !== oldClusterKey && this.clusteredRows.has(newClusterKey)) {
        throw primaryKeyConflict(this.name, this.primaryKeyColumns());
      }
      const candidate: Row = { rowid: key, values };
      this.validate(candidate, key);
      if (newClusterKey !== oldClusterKey) this.clusteredRows.delete(oldClusterKey);
      this.clusteredRows.set(newClusterKey, candidate);
      this.rows.set(key, candidate);
      return candidate;
    }

    const alias = this.integerPrimaryKeyAlias();
    const targetKey = alias ? asRowid(values.get(normalizeColumnName(alias.name)) ?? null, alias.name) : key;
    if (targetKey !== key && this.rows.has(targetKey)) {
      throw new SqliteError(`UNIQUE constraint failed: ${this.name}.${alias?.name ?? "rowid"}`, "constraint_unique", "SQLITE_CONSTRAINT_UNIQUE");
    }
    if (alias) values.set(normalizeColumnName(alias.name), targetKey);
    const candidate: Row = { rowid: targetKey, values };
    this.validate(candidate, key);
    if (targetKey !== key) this.rows.delete(key);
    this.rows.set(targetKey, candidate);
    this.advanceNextRowid(targetKey);
    return candidate;
  }

  delete(rowid: Rowid): boolean {
    const key = canonicalRowid(rowid);
    const existing = this.rows.get(key);
    if (!existing) return false;
    if (this.withoutRowid) this.clusteredRows.delete(this.makeClusterKey(existing.values));
    return this.rows.delete(key);
  }

  *scan(): Iterable<Row> {
    if (this.withoutRowid) {
      const rows = [...this.clusteredRows.values()].sort((a, b) => this.comparePrimaryKeys(a, b));
      yield* rows;
      return;
    }
    const rows = [...this.rows.values()].sort((a, b) => compareRowids(a.rowid, b.rowid));
    yield* rows;
  }

  clone(): Table {
    const copy = new Table(this.name, this.columns, {
      constraints: this.constraints,
      indexes: this.indexes,
      originalSql: this.originalSql,
      withoutRowid: this.withoutRowid,
    });
    copy.nextRowid = this.nextRowid;
    for (const [rowid, row] of this.rows) copy.rows.set(rowid, cloneRow(row));
    for (const [clusterKey, row] of this.clusteredRows) copy.clusteredRows.set(clusterKey, cloneRow(row));
    return copy;
  }

  /** Rebuild clustered storage after snapshot decode or bulk load. */
  rebuildClusteredRows(): void {
    if (!this.withoutRowid) return;
    this.clusteredRows.clear();
    for (const row of this.rows.values()) {
      this.clusteredRows.set(this.makeClusterKey(row.values), row);
    }
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
        if (values.every((value, index) => {
          const column = this.column(names[index]!);
          const otherValue = other.values.get(normalizeColumnName(names[index]!)) ?? null;
          const collation = column.collate ?? "BINARY";
          return compareWithCollation(value, otherValue, collation) === 0;
        })) {
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

  private primaryKeyColumns(): ColumnInfo[] {
    const tablePrimary = this.constraints.find((constraint) => constraint.type === "primary_key");
    if (tablePrimary) {
      return tablePrimary.columns.map((column) => this.column(column.name));
    }
    return this.columns.filter((column) => column.primaryKey);
  }

  private makeClusterKey(values: Map<string, SqlValue>): string {
    return this.primaryKeyColumns()
      .map((column) => {
        const value = values.get(normalizeColumnName(column.name)) ?? null;
        const normalized = normalizeForCollation(value, column.collate ?? "BINARY");
        return serializePkComponent(normalized);
      })
      .join("\0");
  }

  private comparePrimaryKeys(left: Row, right: Row): number {
    for (const column of this.primaryKeyColumns()) {
      const leftValue = left.values.get(normalizeColumnName(column.name)) ?? null;
      const rightValue = right.values.get(normalizeColumnName(column.name)) ?? null;
      const comparison = column.collate
        ? compareWithCollation(leftValue, rightValue, column.collate)
        : compareSql(leftValue, rightValue);
      if (comparison !== 0) return comparison ?? 0;
    }
    return 0;
  }

  private integerPrimaryKeyAlias(): ColumnInfo | undefined {
    if (this.withoutRowid) return undefined;
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
    collate: options.collate ?? null,
    generated: options.generated ?? null,
  };
}

function cloneColumn(column: ColumnInfo): ColumnInfo {
  return {
    ...column,
    defaultExpr: column.defaultExpr === null ? null : cloneAst(column.defaultExpr),
    generated: column.generated === null
      ? null
      : { expr: cloneAst(column.generated.expr), stored: column.generated.stored },
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

function serializePkComponent(value: SqlValue): string {
  if (value === null) return "\0n";
  if (typeof value === "bigint") return `\0b:${value.toString()}`;
  if (typeof value === "number") return `\0i:${value}`;
  if (typeof value === "string") return `\0s:${value}`;
  return `\0x:${Array.from(value).join(",")}`;
}

function primaryKeyConflict(tableName: string, columns: ColumnInfo[]): never {
  const qualified = columns.map((column) => `${tableName}.${column.name}`).join(", ");
  throw new SqliteError(`UNIQUE constraint failed: ${qualified}`, "constraint_primary", "SQLITE_CONSTRAINT_PRIMARYKEY");
}
