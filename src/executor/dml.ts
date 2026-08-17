import type { DeleteStmt, Expr, InsertStmt, ResultColumn, SetItem, UpdateStmt } from "../ast/nodes.ts";
import { checkTableConstraints } from "../constraints/check.ts";
import { SqliteError, unsupported } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import type { Row, Rowid } from "../storage/row.ts";
import { normalizeColumnName } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { applyAffinity, compareSql, isTruthySql, type SqlValue } from "../types/value.ts";
import type { ExecutionEnv, ScopeRow } from "./env.ts";
import { executeSelect } from "./select.ts";
import { resultValues, valuesToResult, type ResultSet } from "./result.ts";

export function executeInsert(stmt: InsertStmt, env: ExecutionEnv): ResultSet {
  const table = env.state.getTable(stmt.table);
  const columnNames = stmt.columns ?? table.columns.map((column) => column.name);
  const rowidIndexes = columnNames
    .map((name, index) => isRowidName(name) ? index : -1)
    .filter((index) => index >= 0);
  if (rowidIndexes.length > 1) throw new SqliteError("duplicate column name: rowid", "other");
  for (const name of columnNames) if (!isRowidName(name)) columnOf(table, name);
  const sourceRows = stmt.values
    ? stmt.values.map((items) => items.map((expr) => evalExpr(expr, env.createEvalContext())))
    : stmt.select ? resultValues(executeSelect({ ...stmt.select, with: stmt.with ?? stmt.select.with }, env)) : [[]];
  const returningRows: SqlValue[][] = [];
  let changes = 0;
  let last = env.state.lastInsertRowid;

  for (const source of sourceRows) {
    if (source.length !== columnNames.length) throw new SqliteError(`${source.length} values for ${columnNames.length} columns`, "other");
    const values = new Map<string, SqlValue>();
    for (const column of table.columns) {
      const suppliedIndex = columnNames.findIndex((name) => name.toLowerCase() === column.name.toLowerCase());
      const value = suppliedIndex >= 0
        ? source[suppliedIndex] ?? null
        : column.defaultExpr ? evalExpr(column.defaultExpr, env.createEvalContext()) : null;
      values.set(normalizeColumnName(column.name), applyAffinity(value, column.affinity));
    }

    const conflicts = conflictingRows(table, values, env);
    if (conflicts.length > 0) {
      if (stmt.upsert) {
        if (stmt.upsert.action === "nothing") continue;
        const row = conflicts[0]!;
        const scope = scopeFor(table, row, stmt.table);
        const excluded: ScopeRow = {
          cells: table.columns.map((column) => ({ table: "excluded", name: column.name, value: values.get(normalizeColumnName(column.name)) ?? null })),
        };
        const merged = { cells: [...scope.cells, ...excluded.cells], rowid: row.rowid, sourceTable: table.name };
        const ctx = env.createEvalContext(merged);
        if (stmt.upsert.action.where && isTruthySql(evalExpr(stmt.upsert.action.where, ctx)) !== true) continue;
        const updates = evaluateSet(stmt.upsert.action.set, table, ctx);
        updateOne(table, row, updates, env);
        changes++;
        if (stmt.returning.length) returningRows.push(projectReturning(stmt.returning, scopeFor(table, table.rows.get(row.rowid)!, stmt.table), env));
        continue;
      }
      const mode = stmt.mode;
      if (mode === "insert_or_ignore") continue;
      if (mode === "replace" || mode === "insert_or_replace") {
        for (const row of conflicts) removeOne(table, row, env);
      } else {
        throw new SqliteError(`UNIQUE constraint failed: ${table.name}`, "constraint_unique", "SQLITE_CONSTRAINT_UNIQUE");
      }
    }

    let insertedRowid: Rowid | undefined;
    try {
      const suppliedRowid = rowidIndexes.length
        ? asExplicitRowid(source[rowidIndexes[0]!] ?? null)
        : undefined;
      const rowid = table.insert({ values, rowid: suppliedRowid });
      insertedRowid = rowid;
      const row = table.rows.get(rowid)!;
      validateRow(table, row, env);
      addIndexes(table, row, env);
      checkForeignKeys(table, row, env);
      changes++;
      last = rowid;
      if (stmt.returning.length) returningRows.push(projectReturning(stmt.returning, scopeFor(table, row, stmt.table), env));
    } catch (error) {
      if (insertedRowid !== undefined) {
        const inserted = table.rows.get(insertedRowid);
        if (inserted) removeOne(table, inserted, env);
      }
      if (stmt.mode === "insert_or_ignore" && error instanceof SqliteError && error.category.startsWith("constraint")) continue;
      throw error;
    }
  }
  env.state.recordChange(changes, last);
  return valuesToResult(returningNames(stmt.returning, table), returningRows, changes, last);
}

export function executeUpdate(stmt: UpdateStmt, env: ExecutionEnv): ResultSet {
  if (stmt.from) unsupported("UPDATE FROM");
  const table = env.state.getTable(stmt.table);
  const selected = [...table.scan()].filter((row) => {
    if (!stmt.where) return true;
    return isTruthySql(evalExpr(stmt.where, env.createEvalContext(scopeFor(table, row, stmt.alias ?? stmt.table)))) === true;
  });
  const returningRows: SqlValue[][] = [];
  let changes = 0;
  for (const row of selected) {
    const ctx = env.createEvalContext(scopeFor(table, row, stmt.alias ?? stmt.table));
    const updates = evaluateSet(stmt.set, table, ctx);
    try {
      updateOne(table, row, updates, env);
      changes++;
      if (stmt.returning.length) returningRows.push(projectReturning(stmt.returning, scopeFor(table, table.rows.get(row.rowid)!, stmt.alias ?? stmt.table), env));
    } catch (error) {
      if (stmt.or === "ignore" && error instanceof SqliteError && error.category.startsWith("constraint")) continue;
      throw error;
    }
  }
  env.state.recordChange(changes);
  return valuesToResult(returningNames(stmt.returning, table), returningRows, changes, env.state.lastInsertRowid);
}

export function executeDelete(stmt: DeleteStmt, env: ExecutionEnv): ResultSet {
  const table = env.state.getTable(stmt.table);
  const selected = [...table.scan()].filter((row) => {
    if (!stmt.where) return true;
    return isTruthySql(evalExpr(stmt.where, env.createEvalContext(scopeFor(table, row, stmt.alias ?? stmt.table)))) === true;
  });
  const returningRows: SqlValue[][] = [];
  for (const row of selected) {
    if (stmt.returning.length) returningRows.push(projectReturning(stmt.returning, scopeFor(table, row, stmt.alias ?? stmt.table), env));
    applyReferentialDelete(table, row, env);
    removeOne(table, row, env);
  }
  env.state.recordChange(selected.length);
  return valuesToResult(returningNames(stmt.returning, table), returningRows, selected.length, env.state.lastInsertRowid);
}

function evaluateSet(items: SetItem[], table: Table, ctx: ReturnType<ExecutionEnv["createEvalContext"]>): Map<string, SqlValue> {
  const updates = new Map<string, SqlValue>();
  for (const item of items) {
    if (item.columns.length === 1) {
      const column = columnOf(table, item.columns[0]!);
      updates.set(normalizeColumnName(column.name), evalExpr(item.expr, ctx));
      continue;
    }
    if (item.expr.type !== "row" || item.expr.values.length !== item.columns.length) {
      throw new SqliteError(`${item.columns.length} columns assigned ${item.expr.type === "row" ? item.expr.values.length : 1} values`, "other");
    }
    item.columns.forEach((name, index) => {
      const column = columnOf(table, name);
      updates.set(normalizeColumnName(column.name), evalExpr(item.expr.type === "row" ? item.expr.values[index]! : item.expr, ctx));
    });
  }
  return updates;
}

function updateOne(table: Table, row: Row, updates: Map<string, SqlValue>, env: ExecutionEnv): void {
  const before = { rowid: row.rowid, values: new Map(row.values) };
  removeIndexes(table, before, env);
  try {
    table.update(row.rowid, updates);
    const after = table.rows.get(row.rowid)!;
    validateRow(table, after, env);
    addIndexes(table, after, env);
    checkForeignKeys(table, after, env);
  } catch (error) {
    table.rows.set(before.rowid, before);
    addIndexes(table, before, env);
    throw error;
  }
}

function validateRow(table: Table, row: Row, env: ExecutionEnv): void {
  checkTableConstraints(table, row, (expr, candidate) => evalExpr(expr, env.createEvalContext(scopeFor(table, candidate, table.name))));
}

function addIndexes(table: Table, row: Row, env: ExecutionEnv): void {
  for (const name of table.indexes) {
    const index = env.state.indexes.get(name.toLowerCase());
    if (!index) continue;
    if (index.where && isTruthySql(evalExpr(index.where, env.createEvalContext(scopeFor(table, row, table.name)))) !== true) continue;
    index.store.insert(index.columns.map((column) => row.values.get(normalizeColumnName(column.name)) ?? null), row.rowid);
  }
}

function removeIndexes(table: Table, row: Row, env: ExecutionEnv): void {
  for (const name of table.indexes) {
    const index = env.state.indexes.get(name.toLowerCase());
    if (index) index.store.remove(index.columns.map((column) => row.values.get(normalizeColumnName(column.name)) ?? null), row.rowid);
  }
}

function removeOne(table: Table, row: Row, env: ExecutionEnv): void {
  removeIndexes(table, row, env);
  table.delete(row.rowid);
}

function conflictingRows(table: Table, values: Map<string, SqlValue>, env: ExecutionEnv): Row[] {
  const sets: string[][] = [];
  const hasTablePrimary = table.constraints.some((constraint) => constraint.type === "primary_key");
  for (const column of table.columns) {
    if (column.unique || column.primaryKey && !hasTablePrimary) sets.push([column.name]);
  }
  for (const constraint of table.constraints) {
    if (constraint.type === "unique" || constraint.type === "primary_key") sets.push(constraint.columns.map((column) => column.name));
  }
  for (const indexName of table.indexes) {
    const index = env.state.indexes.get(indexName.toLowerCase());
    if (index?.unique) sets.push(index.columns.map((column) => column.name));
  }
  return [...table.scan()].filter((row) => sets.some((names) => {
    const desired = names.map((name) => values.get(normalizeColumnName(name)) ?? null);
    return desired.every((value) => value !== null) && desired.every((value, index) => compareSql(value, row.values.get(normalizeColumnName(names[index]!)) ?? null) === 0);
  }));
}

function checkForeignKeys(table: Table, row: Row, env: ExecutionEnv): void {
  if (!env.state.foreignKeysEnabled) return;
  const references: { columns: string[]; table: string; refColumns: string[] | null }[] = [];
  for (const column of table.columns) {
    const definition = table.constraints;
    void definition;
    const original = row;
    void original;
  }
  for (const constraint of table.constraints) {
    if (constraint.type === "foreign_key") references.push({ columns: constraint.columns, table: constraint.refTable, refColumns: constraint.refColumns });
  }
  for (const reference of references) {
    const values = reference.columns.map((name) => row.values.get(normalizeColumnName(name)) ?? null);
    if (values.some((value) => value === null)) continue;
    const parent = env.state.getTable(reference.table);
    const parentColumns = reference.refColumns ?? parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (![...parent.scan()].some((candidate) => values.every((value, index) => compareSql(value, candidate.values.get(normalizeColumnName(parentColumns[index]!)) ?? null) === 0))) {
      throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
    }
  }
}

function applyReferentialDelete(parent: Table, row: Row, env: ExecutionEnv): void {
  if (!env.state.foreignKeysEnabled) return;
  const parentPk = parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
  for (const child of env.state.tables.values()) {
    for (const constraint of child.constraints) {
      if (constraint.type !== "foreign_key" || constraint.refTable.toLowerCase() !== parent.name.toLowerCase()) continue;
      const referenced = constraint.refColumns ?? parentPk;
      const matches = [...child.scan()].filter((candidate) => constraint.columns.every((name, index) =>
        compareSql(candidate.values.get(normalizeColumnName(name)) ?? null, row.values.get(normalizeColumnName(referenced[index]!)) ?? null) === 0,
      ));
      for (const candidate of matches) {
        if (constraint.onDelete === "CASCADE") removeOne(child, candidate, env);
        else if (constraint.onDelete === "SET NULL") updateOne(child, candidate, new Map(constraint.columns.map((name) => [normalizeColumnName(name), null])), env);
        else throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
      }
    }
  }
}

function scopeFor(table: Table, row: Row, alias: string): ScopeRow {
  return {
    rowid: row.rowid,
    rowidName: table.columns.find((column) =>
      column.primaryKey && column.typeName?.trim().toUpperCase() === "INTEGER"
    )?.name ?? "rowid",
    sourceTable: table.name,
    cells: table.columns.map((column) => ({
      table: alias,
      name: column.name,
      value: row.values.get(normalizeColumnName(column.name)) ?? null,
      affinity: column.affinity,
    })),
  };
}

function projectReturning(columns: ResultColumn[], scope: ScopeRow, env: ExecutionEnv): SqlValue[] {
  const values: SqlValue[] = [];
  const ctx = env.createEvalContext(scope);
  for (const column of columns) {
    if (column.type === "star") {
      for (const cell of scope.cells) if (column.table === null || cell.table?.toLowerCase() === column.table.toLowerCase()) values.push(cell.value);
    } else values.push(evalExpr(column.expr, ctx));
  }
  return values;
}

function returningNames(columns: ResultColumn[], table: Table): string[] {
  return columns.flatMap((column) => column.type === "star"
    ? table.columns.map((item) => item.name)
    : [column.alias ?? (column.expr.type === "column" ? column.expr.name : column.expr.type)]);
}

function columnOf(table: Table, name: string) {
  const column = table.columns.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!column) throw new SqliteError(`no such column: ${name}`, "no_such_column");
  return column;
}

function isRowidName(name: string): boolean {
  const key = name.toLowerCase();
  return key === "rowid" || key === "_rowid_" || key === "oid";
}

function asExplicitRowid(value: SqlValue): Rowid | undefined {
  if (value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new SqliteError("datatype mismatch", "datatype_mismatch", "SQLITE_MISMATCH");
}
