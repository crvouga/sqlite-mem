import type {
  CreateIndexStmt,
  CreateTableStmt,
  CreateViewStmt,
  Expr,
  IndexedColumn,
  SelectStmt,
} from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { IndexStore } from "../indexes/index.ts";
import { affinityFromTypeName } from "../types/value.ts";
import type { Rowid } from "./row.ts";
import type { ColumnInfo } from "./table.ts";
import { Table } from "./table.ts";

export interface ViewInfo {
  name: string;
  columns: string[] | null;
  select: SelectStmt;
  originalSql: string | null;
}

export interface IndexInfo {
  name: string;
  tableName: string;
  unique: boolean;
  columns: IndexedColumn[];
  where: Expr | null;
  originalSql: string | null;
  store: IndexStore;
}

export class DatabaseState {
  tables = new Map<string, Table>();
  views = new Map<string, ViewInfo>();
  indexes = new Map<string, IndexInfo>();
  lastInsertRowid: Rowid = 0;
  changes = 0;
  totalChanges = 0;
  foreignKeysEnabled = false;
  schemaVersion = 0;

  getTable(name: string): Table {
    const table = this.tables.get(keyOf(name));
    if (!table) throw new SqliteError(`no such table: ${name}`, "no_such_table");
    return table;
  }

  createTable(stmt: CreateTableStmt, originalSql: string | null = null): Table {
    const key = keyOf(stmt.name);
    const existing = this.tables.get(key);
    if (existing && stmt.ifNotExists) return existing;
    this.assertSchemaNameAvailable(stmt.name);

    const seenColumns = new Set<string>();
    const tablePrimaryNames = new Set(
      stmt.constraints
        .filter((constraint) => constraint.type === "primary_key")
        .flatMap((constraint) => constraint.columns.map((column) => keyOf(column.name))),
    );
    if (stmt.constraints.filter((constraint) => constraint.type === "primary_key").length > 1) {
      throw new SqliteError("table has more than one primary key", "constraint_primary");
    }
    const columnPrimaryCount = stmt.columns.filter((column) =>
      column.constraints.some((constraint) => constraint.type === "primary_key"),
    ).length;
    if (columnPrimaryCount > 1) {
      throw new SqliteError("table has more than one primary key", "constraint_primary");
    }

    const columns: ColumnInfo[] = stmt.columns.map((definition) => {
      const columnKey = keyOf(definition.name);
      if (seenColumns.has(columnKey)) throw new SqliteError(`duplicate column name: ${definition.name}`, "other");
      seenColumns.add(columnKey);

      const primary = definition.constraints.find((constraint) => constraint.type === "primary_key");
      const primaryKey = primary !== undefined || tablePrimaryNames.has(columnKey);
      const autoincrement = primary?.type === "primary_key" && primary.autoincrement;
      if (autoincrement && definition.typeName?.trim().toUpperCase() !== "INTEGER") {
        throw new SqliteError("AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY", "unsupported");
      }

      return {
        name: definition.name,
        typeName: definition.typeName,
        affinity: affinityFromTypeName(definition.typeName),
        notNull: definition.constraints.some((constraint) => constraint.type === "not_null"),
        primaryKey,
        autoincrement,
        defaultExpr: definition.constraints.find((constraint) => constraint.type === "default")?.expr ?? null,
        unique: definition.constraints.some((constraint) => constraint.type === "unique"),
      };
    });

    for (const constraint of stmt.constraints) {
      const localNames =
        constraint.type === "primary_key" || constraint.type === "unique"
          ? constraint.columns.map((column) => column.name)
          : constraint.type === "foreign_key"
            ? constraint.columns
            : [];
      for (const name of localNames) {
        if (!seenColumns.has(keyOf(name))) throw new SqliteError(`no such column: ${name}`, "no_such_column");
      }
    }
    const hasColumnPrimary = stmt.columns.some((column) =>
      column.constraints.some((constraint) => constraint.type === "primary_key"),
    );
    if (hasColumnPrimary && tablePrimaryNames.size > 0) {
      throw new SqliteError("table has more than one primary key", "constraint_primary");
    }
    if (stmt.columns.length === 0) {
      throw new SqliteError("table must have at least one column", "syntax");
    }

    const normalizedConstraints = [...stmt.constraints];
    for (const definition of stmt.columns) {
      for (const constraint of definition.constraints) {
        if (constraint.type === "check") {
          normalizedConstraints.push({ type: "check", expr: constraint.expr, name: null });
        } else if (constraint.type === "references") {
          normalizedConstraints.push({
            type: "foreign_key",
            columns: [definition.name],
            refTable: constraint.table,
            refColumns: constraint.columns,
            onDelete: constraint.onDelete,
            onUpdate: constraint.onUpdate,
            name: null,
          });
        }
      }
    }
    const table = new Table(stmt.name, columns, {
      constraints: normalizedConstraints,
      originalSql,
    });
    this.tables.set(key, table);
    this.schemaVersion++;
    return table;
  }

  dropTable(name: string, ifExists = false): boolean {
    const key = keyOf(name);
    const table = this.tables.get(key);
    if (!table) {
      if (ifExists) return false;
      throw new SqliteError(`no such table: ${name}`, "no_such_table");
    }
    for (const [indexKey, index] of this.indexes) {
      if (keyOf(index.tableName) === key) this.indexes.delete(indexKey);
    }
    this.tables.delete(key);
    this.schemaVersion++;
    return true;
  }

  renameTable(oldName: string, newName: string): Table {
    const oldKey = keyOf(oldName);
    const table = this.getTable(oldName);
    this.assertSchemaNameAvailable(newName);
    this.tables.delete(oldKey);
    table.name = newName;
    this.tables.set(keyOf(newName), table);
    for (const index of this.indexes.values()) {
      if (keyOf(index.tableName) === oldKey) index.tableName = newName;
    }
    this.schemaVersion++;
    return table;
  }

  createView(stmt: CreateViewStmt, originalSql: string | null = null): ViewInfo {
    const key = keyOf(stmt.name);
    const existing = this.views.get(key);
    if (existing && stmt.ifNotExists) return existing;
    this.assertSchemaNameAvailable(stmt.name);
    const view: ViewInfo = {
      name: stmt.name,
      columns: stmt.columns ? [...stmt.columns] : null,
      select: structuredClone(stmt.select),
      originalSql,
    };
    this.views.set(key, view);
    this.schemaVersion++;
    return view;
  }

  dropView(name: string, ifExists = false): boolean {
    const deleted = this.views.delete(keyOf(name));
    if (!deleted && !ifExists) throw new SqliteError(`no such view: ${name}`, "other");
    if (deleted) this.schemaVersion++;
    return deleted;
  }

  createIndex(stmt: CreateIndexStmt, originalSql: string | null = null): IndexInfo {
    const key = keyOf(stmt.name);
    const existing = this.indexes.get(key);
    if (existing && stmt.ifNotExists) return existing;
    this.assertSchemaNameAvailable(stmt.name);
    const table = this.getTable(stmt.table);
    for (const indexed of stmt.columns) {
      if (!table.columns.some((column) => keyOf(column.name) === keyOf(indexed.name))) {
        throw new SqliteError(`no such column: ${indexed.name}`, "no_such_column");
      }
    }
    const index: IndexInfo = {
      name: stmt.name,
      tableName: table.name,
      unique: stmt.unique,
      columns: structuredClone(stmt.columns),
      where: stmt.where ? structuredClone(stmt.where) : null,
      originalSql,
      store: new IndexStore(stmt.name),
    };
    this.indexes.set(key, index);
    table.indexes.push(index.name);
    this.schemaVersion++;
    return index;
  }

  dropIndex(name: string, ifExists = false): boolean {
    const key = keyOf(name);
    const index = this.indexes.get(key);
    if (!index) {
      if (ifExists) return false;
      throw new SqliteError(`no such index: ${name}`, "other");
    }
    this.indexes.delete(key);
    const table = this.tables.get(keyOf(index.tableName));
    if (table) table.indexes = table.indexes.filter((item) => keyOf(item) !== key);
    this.schemaVersion++;
    return true;
  }

  recordChange(count: number, lastInsertRowid?: Rowid): void {
    this.changes = count;
    this.totalChanges += count;
    if (lastInsertRowid !== undefined) this.lastInsertRowid = lastInsertRowid;
  }

  clone(): DatabaseState {
    const copy = new DatabaseState();
    for (const [key, table] of this.tables) copy.tables.set(key, table.clone());
    for (const [key, view] of this.views) {
      copy.views.set(key, {
        name: view.name,
        columns: view.columns ? [...view.columns] : null,
        select: structuredClone(view.select),
        originalSql: view.originalSql,
      });
    }
    for (const [key, index] of this.indexes) {
      copy.indexes.set(key, {
        name: index.name,
        tableName: index.tableName,
        unique: index.unique,
        columns: structuredClone(index.columns),
        where: index.where ? structuredClone(index.where) : null,
        originalSql: index.originalSql,
        store: index.store.clone(),
      });
    }
    copy.lastInsertRowid = this.lastInsertRowid;
    copy.changes = this.changes;
    copy.totalChanges = this.totalChanges;
    copy.foreignKeysEnabled = this.foreignKeysEnabled;
    copy.schemaVersion = this.schemaVersion;
    return copy;
  }

  replaceWith(state: DatabaseState): void {
    const copy = state.clone();
    this.tables = copy.tables;
    this.views = copy.views;
    this.indexes = copy.indexes;
    this.lastInsertRowid = copy.lastInsertRowid;
    this.changes = copy.changes;
    this.totalChanges = copy.totalChanges;
    this.foreignKeysEnabled = copy.foreignKeysEnabled;
    this.schemaVersion = copy.schemaVersion;
  }

  private assertSchemaNameAvailable(name: string): void {
    const key = keyOf(name);
    if (this.tables.has(key) || this.views.has(key) || this.indexes.has(key)) {
      throw new SqliteError(`object already exists: ${name}`, "other");
    }
  }
}

function keyOf(name: string): string {
  return name.toLowerCase();
}
