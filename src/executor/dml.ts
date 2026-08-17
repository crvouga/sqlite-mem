import type { DeleteStmt, IndexedColumn, InsertStmt, ResultColumn, SetItem, UpdateStmt } from "../ast/nodes.ts";
import { checkTableConstraints } from "../constraints/check.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import type { Row, Rowid } from "../storage/row.ts";
import { normalizeColumnName } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { normalizeForCollation } from "../types/collation.ts";
import { applyAffinity, compareSql, isTruthySql, type SqlValue } from "../types/value.ts";
import type { Fts5Row, Fts5VirtualTable } from "../vtable/fts5.ts";
import type { ExecutionEnv, ScopeRow } from "./env.ts";
import { type ResultSet, resultValues, valuesToResult } from "./result.ts";
import { executeSelect, scanFrom } from "./select.ts";
import { fireDeleteTriggers, fireInsertTriggers, fireUpdateTriggers } from "./triggers.ts";
import { executeFtsDelete, executeFtsInsert, executeFtsUpdate } from "./vtable.ts";

export function executeInsert(stmt: InsertStmt, env: ExecutionEnv): ResultSet {
  if (env.state.isVirtualTable(stmt.table)) {
    return executeVirtualInsert(stmt, env);
  }
  const table = env.state.getTable(stmt.table);
  const columnNames = stmt.columns ?? table.columns.map((column) => column.name);
  const rowidIndexes = columnNames.map((name, index) => (isRowidName(name) ? index : -1)).filter((index) => index >= 0);
  if (rowidIndexes.length > 1) throw new SqliteError("duplicate column name: rowid", "other");
  if (table.withoutRowid && rowidIndexes.length > 0) {
    throw new SqliteError(`table ${table.name} has no column named rowid`, "other");
  }
  for (const name of columnNames) if (!isRowidName(name)) columnOf(table, name);
  const sourceRows = stmt.values
    ? stmt.values.map((items) => items.map((expr) => evalExpr(expr, env.createEvalContext())))
    : stmt.select
      ? resultValues(executeSelect({ ...stmt.select, with: stmt.with ?? stmt.select.with }, env))
      : [[]];
  const returningRows: SqlValue[][] = [];
  let changes = 0;
  let last = env.state.lastInsertRowid;

  for (const source of sourceRows) {
    if (source.length !== columnNames.length)
      throw new SqliteError(`${source.length} values for ${columnNames.length} columns`, "other");
    const values = new Map<string, SqlValue>();
    for (const column of table.columns) {
      if (column.generated) continue;
      const suppliedIndex = columnNames.findIndex((name) => name.toLowerCase() === column.name.toLowerCase());
      const value =
        suppliedIndex >= 0
          ? (source[suppliedIndex] ?? null)
          : column.defaultExpr
            ? evalExpr(column.defaultExpr, env.createEvalContext())
            : null;
      values.set(normalizeColumnName(column.name), applyAffinity(value, column.affinity));
    }
    for (const column of table.columns) {
      if (!column.generated) continue;
      if (columnNames.some((name) => name.toLowerCase() === column.name.toLowerCase())) {
        throw new SqliteError(`cannot INSERT into generated column "${column.name}"`, "misuse");
      }
      if (column.generated.stored) {
        const genCtx = env.createEvalContext({
          cells: table.columns
            .filter((c) => !c.generated || c === column)
            .flatMap((c) => {
              if (c.generated && c !== column) return [];
              if (c === column) return [];
              return [
                {
                  table: table.name,
                  name: c.name,
                  value: values.get(normalizeColumnName(c.name)) ?? null,
                  affinity: c.affinity,
                  collate: c.collate,
                },
              ];
            }),
        });
        const computed = evalExpr(column.generated.expr, genCtx);
        values.set(normalizeColumnName(column.name), applyAffinity(computed, column.affinity));
      } else {
        values.set(normalizeColumnName(column.name), null);
      }
    }

    if (fireInsertTriggers("BEFORE", table, values, null, env) === "ignore") continue;

    const conflicts = conflictingRows(table, values, env);
    if (conflicts.length > 0) {
      if (stmt.upsert) {
        const targetConflicts = stmt.upsert.targetColumns
          ? conflictsMatchingTarget(table, values, env, stmt.upsert.targetColumns)
          : conflicts;
        if (targetConflicts.length === 0) {
          // Conflict is on a different unique constraint than the ON CONFLICT target.
          throw new SqliteError(
            `UNIQUE constraint failed: ${table.name}`,
            "constraint_unique",
            "SQLITE_CONSTRAINT_UNIQUE",
          );
        }
        if (stmt.upsert.action === "nothing") continue;
        const row = targetConflicts[0]!;
        const scope = scopeFor(table, row, stmt.table, env);
        const excluded: ScopeRow = {
          cells: table.columns.map((column) => ({
            table: "excluded",
            name: column.name,
            value: values.get(normalizeColumnName(column.name)) ?? null,
          })),
        };
        const merged = { cells: [...scope.cells, ...excluded.cells], rowid: row.rowid, sourceTable: table.name };
        const ctx = env.createEvalContext(merged);
        if (stmt.upsert.action.where && isTruthySql(evalExpr(stmt.upsert.action.where, ctx)) !== true) continue;
        const updates = evaluateSet(stmt.upsert.action.set, table, ctx);
        const updated = updateOne(table, row, updates, env);
        changes += 1 + updated.cascaded;
        if (stmt.returning.length)
          returningRows.push(projectReturning(stmt.returning, scopeFor(table, updated.row, stmt.table, env), env));
        continue;
      }
      const mode = stmt.mode;
      if (mode === "insert_or_ignore") continue;
      if (mode === "replace" || mode === "insert_or_replace") {
        for (const row of conflicts) removeOne(table, row, env);
      } else {
        throw new SqliteError(
          `UNIQUE constraint failed: ${table.name}`,
          "constraint_unique",
          "SQLITE_CONSTRAINT_UNIQUE",
        );
      }
    }

    let insertedRowid: Rowid | undefined;
    try {
      const suppliedRowid = rowidIndexes.length ? asExplicitRowid(source[rowidIndexes[0]!] ?? null) : undefined;
      const rowid = table.insert({ values, rowid: suppliedRowid });
      insertedRowid = rowid;
      const row = table.rows.get(rowid)!;
      validateRow(table, row, env);
      addIndexes(table, row, env);
      checkForeignKeys(table, row, env);
      fireInsertTriggers("AFTER", table, row.values, null, env);
      changes++;
      last = table.withoutRowid ? 0 : rowid;
      if (stmt.returning.length)
        returningRows.push(projectReturning(stmt.returning, scopeFor(table, row, stmt.table, env), env));
    } catch (error) {
      if (insertedRowid !== undefined) {
        const inserted = table.rows.get(insertedRowid);
        if (inserted) removeOne(table, inserted, env);
      }
      if (stmt.mode === "insert_or_ignore" && error instanceof SqliteError && error.category.startsWith("constraint"))
        continue;
      throw error;
    }
  }
  env.state.recordChange(changes, last);
  return valuesToResult(returningNames(stmt.returning, table), returningRows, changes, last);
}

export function executeUpdate(stmt: UpdateStmt, env: ExecutionEnv): ResultSet {
  if (env.state.isVirtualTable(stmt.table)) {
    return executeVirtualUpdate(stmt, env);
  }
  const table = env.state.getTable(stmt.table);
  const alias = stmt.alias ?? stmt.table;
  const candidates: { row: Row; scope: ScopeRow }[] = [];

  if (stmt.from) {
    const fromRows = scanFrom(stmt.from, env);
    for (const row of table.scan()) {
      const targetScope = scopeFor(table, row, alias, env);
      let matchedScope: ScopeRow | null = null;
      for (const fromRow of fromRows) {
        const joined: ScopeRow = {
          ...targetScope,
          cells: [...targetScope.cells, ...fromRow.cells],
        };
        if (stmt.where && isTruthySql(evalExpr(stmt.where, env.createEvalContext(joined))) !== true) continue;
        matchedScope = joined;
        break;
      }
      if (matchedScope) candidates.push({ row, scope: matchedScope });
    }
  } else {
    for (const row of table.scan()) {
      const scope = scopeFor(table, row, alias, env);
      if (stmt.where && isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) !== true) continue;
      candidates.push({ row, scope });
    }
  }

  const returningRows: SqlValue[][] = [];
  let changes = 0;
  for (const { row, scope } of candidates) {
    const ctx = env.createEvalContext(scope);
    const updates = evaluateSet(stmt.set, table, ctx);
    const newValues = mergedValues(table, row, updates);
    const updatedColumns = new Set(
      [...updates.keys()].map((key) => {
        const column = table.columns.find((item) => normalizeColumnName(item.name) === key);
        return column?.name ?? key;
      }),
    );
    if (fireUpdateTriggers("BEFORE", table, row, newValues, updatedColumns, env) === "ignore") continue;
    try {
      const updated = updateOne(table, row, updates, env);
      fireUpdateTriggers("AFTER", table, row, updated.row.values, updatedColumns, env);
      changes += 1 + updated.cascaded;
      if (stmt.returning.length)
        returningRows.push(projectReturning(stmt.returning, scopeFor(table, updated.row, alias, env), env));
    } catch (error) {
      if (stmt.or === "ignore" && error instanceof SqliteError && error.category.startsWith("constraint")) continue;
      throw error;
    }
  }
  env.state.recordChange(changes);
  return valuesToResult(returningNames(stmt.returning, table), returningRows, changes, env.state.lastInsertRowid);
}

export function executeDelete(stmt: DeleteStmt, env: ExecutionEnv): ResultSet {
  if (env.state.isVirtualTable(stmt.table)) {
    return executeVirtualDelete(stmt, env);
  }
  const table = env.state.getTable(stmt.table);
  const selected = [...table.scan()].filter((row) => {
    if (!stmt.where) return true;
    return (
      isTruthySql(evalExpr(stmt.where, env.createEvalContext(scopeFor(table, row, stmt.alias ?? stmt.table, env)))) ===
      true
    );
  });
  const returningRows: SqlValue[][] = [];
  let changes = 0;
  for (const row of selected) {
    if (fireDeleteTriggers("BEFORE", table, row, env) === "ignore") continue;
    if (stmt.returning.length)
      returningRows.push(projectReturning(stmt.returning, scopeFor(table, row, stmt.alias ?? stmt.table, env), env));
    changes += applyReferentialDelete(table, row, env);
    removeOne(table, row, env);
    fireDeleteTriggers("AFTER", table, row, env);
    changes++;
  }
  env.state.recordChange(changes);
  return valuesToResult(returningNames(stmt.returning, table), returningRows, changes, env.state.lastInsertRowid);
}

function mergedValues(table: Table, row: Row, updates: Map<string, SqlValue>): Map<string, SqlValue> {
  const values = new Map<string, SqlValue>();
  for (const column of table.columns) {
    const key = normalizeColumnName(column.name);
    values.set(key, updates.has(key) ? updates.get(key)! : (row.values.get(key) ?? null));
  }
  return values;
}

function evaluateSet(
  items: SetItem[],
  table: Table,
  ctx: ReturnType<ExecutionEnv["createEvalContext"]>,
): Map<string, SqlValue> {
  const updates = new Map<string, SqlValue>();
  for (const item of items) {
    if (item.columns.length === 1) {
      const column = columnOf(table, item.columns[0]!);
      if (column.generated) throw new SqliteError(`cannot UPDATE generated column "${column.name}"`, "misuse");
      updates.set(normalizeColumnName(column.name), evalExpr(item.expr, ctx));
      continue;
    }
    if (item.expr.type !== "row" || item.expr.values.length !== item.columns.length) {
      throw new SqliteError(
        `${item.columns.length} columns assigned ${item.expr.type === "row" ? item.expr.values.length : 1} values`,
        "other",
      );
    }
    item.columns.forEach((name, index) => {
      const column = columnOf(table, name);
      if (column.generated) throw new SqliteError(`cannot UPDATE generated column "${column.name}"`, "misuse");
      updates.set(
        normalizeColumnName(column.name),
        evalExpr(item.expr.type === "row" ? item.expr.values[index]! : item.expr, ctx),
      );
    });
  }
  return updates;
}

function updateOne(
  table: Table,
  row: Row,
  updates: Map<string, SqlValue>,
  env: ExecutionEnv,
): { row: Row; cascaded: number } {
  const before = { rowid: row.rowid, values: new Map(row.values) };
  let after: Row | undefined;
  let indexesAdded = false;
  removeIndexes(table, before, env);
  try {
    const merged = new Map(row.values);
    for (const [name, value] of updates) merged.set(name, value);
    for (const column of table.columns) {
      if (!column.generated?.stored) continue;
      const genCtx = env.createEvalContext({
        cells: table.columns
          .filter((c) => !c.generated)
          .map((c) => ({
            table: table.name,
            name: c.name,
            value: merged.get(normalizeColumnName(c.name)) ?? null,
            affinity: c.affinity,
            collate: c.collate,
          })),
      });
      merged.set(
        normalizeColumnName(column.name),
        applyAffinity(evalExpr(column.generated.expr, genCtx), column.affinity),
      );
    }
    after = table.update(row.rowid, merged);
    if (!after) throw new SqliteError(`no such row: ${row.rowid}`, "other");
    validateRow(table, after, env);
    addIndexes(table, after, env);
    indexesAdded = true;
    checkForeignKeys(table, after, env);
    const cascaded = applyReferentialUpdate(table, before, after, env);
    return { row: after, cascaded };
  } catch (error) {
    if (after) {
      if (indexesAdded) removeIndexes(table, after, env);
      table.delete(after.rowid);
    }
    table.rows.set(before.rowid, before);
    if (table.withoutRowid) {
      // best-effort restore handled by table.update failure paths
    }
    addIndexes(table, before, env);
    throw error;
  }
}

function validateRow(table: Table, row: Row, env: ExecutionEnv): void {
  checkTableConstraints(table, row, (expr, candidate) =>
    evalExpr(expr, env.createEvalContext(scopeFor(table, candidate, table.name, env))),
  );
}

function addIndexes(table: Table, row: Row, env: ExecutionEnv): void {
  const indexes = env.state.databaseForTable(table).indexes;
  for (const name of table.indexes) {
    const index = indexes.get(name.toLowerCase());
    if (!index) continue;
    if (
      index.where &&
      isTruthySql(evalExpr(index.where, env.createEvalContext(scopeFor(table, row, table.name, env)))) !== true
    )
      continue;
    index.store.insert(indexValues(index.columns, row), row.rowid);
  }
}

function removeIndexes(table: Table, row: Row, env: ExecutionEnv): void {
  const indexes = env.state.databaseForTable(table).indexes;
  for (const name of table.indexes) {
    const index = indexes.get(name.toLowerCase());
    if (index) index.store.remove(indexValues(index.columns, row), row.rowid);
  }
}

function removeOne(table: Table, row: Row, env: ExecutionEnv): void {
  removeIndexes(table, row, env);
  table.delete(row.rowid);
}

function conflictingRows(table: Table, values: Map<string, SqlValue>, env: ExecutionEnv): Row[] {
  return conflictsForSets(table, values, uniqueColumnSets(table, env));
}

function conflictsMatchingTarget(
  table: Table,
  values: Map<string, SqlValue>,
  env: ExecutionEnv,
  targetColumns: string[],
): Row[] {
  const targetKeys = targetColumns.map((name) => normalizeColumnName(name));
  const matchingSets = uniqueColumnSets(table, env).filter((columns) => {
    if (columns.length !== targetKeys.length) return false;
    const setKeys = columns.map((column) => normalizeColumnName(column.name));
    return targetKeys.every((key) => setKeys.includes(key));
  });
  if (matchingSets.length === 0) {
    // Infer INTEGER PRIMARY KEY / rowid target.
    if (
      targetKeys.length === 1 &&
      (targetKeys[0] === "rowid" ||
        table.columns.some((column) => normalizeColumnName(column.name) === targetKeys[0] && column.primaryKey))
    ) {
      const pkSets = uniqueColumnSets(table, env).filter(
        (columns) =>
          columns.length === 1 &&
          (normalizeColumnName(columns[0]!.name) === targetKeys[0] ||
            table.columns.find((column) => normalizeColumnName(column.name) === normalizeColumnName(columns[0]!.name))
              ?.primaryKey),
      );
      return conflictsForSets(
        table,
        values,
        pkSets.length > 0 ? pkSets : [[{ name: targetColumns[0]!, collate: null, order: null }]],
      );
    }
    return [];
  }
  return conflictsForSets(table, values, matchingSets);
}

function uniqueColumnSets(table: Table, env: ExecutionEnv): IndexedColumn[][] {
  const sets: IndexedColumn[][] = [];
  const hasTablePrimary = table.constraints.some((constraint) => constraint.type === "primary_key");
  for (const column of table.columns) {
    if (column.unique || (column.primaryKey && !hasTablePrimary)) {
      sets.push([{ name: column.name, collate: column.collate, order: null }]);
    }
  }
  for (const constraint of table.constraints) {
    if (constraint.type === "unique" || constraint.type === "primary_key") sets.push(constraint.columns);
  }
  for (const indexName of table.indexes) {
    const index = env.state.databaseForTable(table).indexes.get(indexName.toLowerCase());
    if (index?.unique) sets.push(index.columns);
  }
  return sets;
}

function conflictsForSets(table: Table, values: Map<string, SqlValue>, sets: IndexedColumn[][]): Row[] {
  return [...table.scan()].filter((row) =>
    sets.some((columns) => {
      const desired = columns.map((column) =>
        normalizeForCollation(values.get(normalizeColumnName(column.name)) ?? null, column.collate ?? "BINARY"),
      );
      const existing = indexValues(columns, row);
      return (
        desired.every((value) => value !== null) &&
        desired.every((value, index) => compareSql(value, existing[index] ?? null) === 0)
      );
    }),
  );
}

function indexValues(columns: IndexedColumn[], row: Row): SqlValue[] {
  return columns.map((column) =>
    normalizeForCollation(row.values.get(normalizeColumnName(column.name)) ?? null, column.collate ?? "BINARY"),
  );
}

function checkForeignKeys(table: Table, row: Row, env: ExecutionEnv): void {
  if (!env.state.foreignKeysEnabled) return;
  const references: { columns: string[]; table: string; refColumns: string[] | null }[] = [];
  for (const constraint of table.constraints) {
    if (constraint.type === "foreign_key")
      references.push({ columns: constraint.columns, table: constraint.refTable, refColumns: constraint.refColumns });
  }
  for (const reference of references) {
    const values = reference.columns.map((name) => row.values.get(normalizeColumnName(name)) ?? null);
    if (values.some((value) => value === null)) continue;
    const parent = env.state.getTable(reference.table);
    const parentColumns =
      reference.refColumns ?? parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (
      ![...parent.scan()].some((candidate) =>
        values.every((value, index) => {
          const parentColumn = parentColumns[index];
          return (
            parentColumn !== undefined &&
            compareSql(value, candidate.values.get(normalizeColumnName(parentColumn)) ?? null) === 0
          );
        }),
      )
    ) {
      throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
    }
  }
}

function applyReferentialDelete(parent: Table, row: Row, env: ExecutionEnv): number {
  if (!env.state.foreignKeysEnabled) return 0;
  let changes = 0;
  const parentPk = parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
  for (const child of env.state.tables.values()) {
    for (const constraint of child.constraints) {
      if (constraint.type !== "foreign_key" || constraint.refTable.toLowerCase() !== parent.name.toLowerCase())
        continue;
      const referenced = constraint.refColumns ?? parentPk;
      const matches = [...child.scan()].filter(
        (candidate) =>
          !(child === parent && candidate.rowid === row.rowid) &&
          foreignKeyMatches(constraint.columns, candidate, referenced, row),
      );
      for (const candidate of matches) {
        if (constraint.onDelete === "CASCADE") {
          changes += applyReferentialDelete(child, candidate, env);
          removeOne(child, candidate, env);
          changes++;
        } else if (constraint.onDelete === "SET NULL") {
          const updated = updateOne(
            child,
            candidate,
            new Map(constraint.columns.map((name) => [normalizeColumnName(name), null])),
            env,
          );
          changes += 1 + updated.cascaded;
        } else if (constraint.onDelete === "SET DEFAULT") {
          const updated = updateOne(child, candidate, defaultUpdates(child, constraint.columns, env), env);
          changes += 1 + updated.cascaded;
        } else
          throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
      }
    }
  }
  return changes;
}

function applyReferentialUpdate(parent: Table, before: Row, after: Row, env: ExecutionEnv): number {
  if (!env.state.foreignKeysEnabled) return 0;
  let changes = 0;
  const parentPk = parent.columns.filter((column) => column.primaryKey).map((column) => column.name);
  for (const child of env.state.tables.values()) {
    for (const constraint of child.constraints) {
      if (constraint.type !== "foreign_key" || constraint.refTable.toLowerCase() !== parent.name.toLowerCase())
        continue;
      const referenced = constraint.refColumns ?? parentPk;
      const oldValues = referenced.map((name) => before.values.get(normalizeColumnName(name)) ?? null);
      const newValues = referenced.map((name) => after.values.get(normalizeColumnName(name)) ?? null);
      if (oldValues.every((value, index) => compareSql(value, newValues[index] ?? null) === 0)) continue;

      const matches = [...child.scan()].filter((candidate) =>
        foreignKeyMatches(constraint.columns, candidate, referenced, before),
      );
      for (const candidate of matches) {
        if (constraint.onUpdate === "CASCADE") {
          const updated = updateOne(
            child,
            candidate,
            new Map(constraint.columns.map((name, index) => [normalizeColumnName(name), newValues[index] ?? null])),
            env,
          );
          changes += 1 + updated.cascaded;
        } else if (constraint.onUpdate === "SET NULL") {
          const updated = updateOne(
            child,
            candidate,
            new Map(constraint.columns.map((name) => [normalizeColumnName(name), null])),
            env,
          );
          changes += 1 + updated.cascaded;
        } else if (constraint.onUpdate === "SET DEFAULT") {
          const updated = updateOne(child, candidate, defaultUpdates(child, constraint.columns, env), env);
          changes += 1 + updated.cascaded;
        } else {
          throw new SqliteError("FOREIGN KEY constraint failed", "constraint_foreign", "SQLITE_CONSTRAINT_FOREIGNKEY");
        }
      }
    }
  }
  return changes;
}

function foreignKeyMatches(childColumns: string[], child: Row, parentColumns: string[], parent: Row): boolean {
  const childValues = childColumns.map((name) => child.values.get(normalizeColumnName(name)) ?? null);
  if (childValues.some((value) => value === null)) return false;
  return childValues.every((value, index) => {
    const parentColumn = parentColumns[index];
    return (
      parentColumn !== undefined &&
      compareSql(value, parent.values.get(normalizeColumnName(parentColumn)) ?? null) === 0
    );
  });
}

function defaultUpdates(table: Table, columns: string[], env: ExecutionEnv): Map<string, SqlValue> {
  return new Map(
    columns.map((name) => {
      const column = columnOf(table, name);
      const value = column.defaultExpr ? evalExpr(column.defaultExpr, env.createEvalContext()) : null;
      return [normalizeColumnName(column.name), value];
    }),
  );
}

function scopeFor(table: Table, row: Row, alias: string, env?: ExecutionEnv): ScopeRow {
  const integerPkAlias = table.withoutRowid
    ? undefined
    : table.columns.find((column) => column.primaryKey && column.typeName?.trim().toUpperCase() === "INTEGER")?.name;
  const baseCells = table.columns
    .filter((c) => !c.generated || c.generated.stored)
    .map((column) => ({
      table: alias,
      name: column.name,
      value: row.values.get(normalizeColumnName(column.name)) ?? null,
      affinity: column.affinity,
      collate: column.collate,
    }));
  const cells = [...baseCells];
  if (env) {
    for (const column of table.columns) {
      if (!column.generated || column.generated.stored) continue;
      const ctx = env.createEvalContext({ cells: baseCells, sourceTable: table.name });
      const value = applyAffinity(evalExpr(column.generated.expr, ctx), column.affinity);
      cells.push({
        table: alias,
        name: column.name,
        value,
        affinity: column.affinity,
        collate: column.collate,
      });
    }
    // Preserve column order
    cells.sort((a, b) => {
      const ai = table.columns.findIndex((c) => c.name.toLowerCase() === a.name.toLowerCase());
      const bi = table.columns.findIndex((c) => c.name.toLowerCase() === b.name.toLowerCase());
      return ai - bi;
    });
  } else {
    for (const column of table.columns) {
      if (!column.generated || column.generated.stored) continue;
      cells.push({
        table: alias,
        name: column.name,
        value: null,
        affinity: column.affinity,
        collate: column.collate,
      });
    }
    cells.sort((a, b) => {
      const ai = table.columns.findIndex((c) => c.name.toLowerCase() === a.name.toLowerCase());
      const bi = table.columns.findIndex((c) => c.name.toLowerCase() === b.name.toLowerCase());
      return ai - bi;
    });
  }
  return {
    ...(table.withoutRowid ? {} : { rowid: row.rowid }),
    rowidName: integerPkAlias ?? (table.withoutRowid ? undefined : "rowid"),
    sourceTable: table.name,
    cells,
  };
}

function projectReturning(columns: ResultColumn[], scope: ScopeRow, env: ExecutionEnv): SqlValue[] {
  const values: SqlValue[] = [];
  const ctx = env.createEvalContext(scope);
  for (const column of columns) {
    if (column.type === "star") {
      for (const cell of scope.cells)
        if (column.table === null || cell.table?.toLowerCase() === column.table.toLowerCase()) values.push(cell.value);
    } else values.push(evalExpr(column.expr, ctx));
  }
  return values;
}

function returningNames(columns: ResultColumn[], table: Table): string[] {
  return columns.flatMap((column) =>
    column.type === "star"
      ? table.columns.map((item) => item.name)
      : [column.alias ?? (column.expr.type === "column" ? column.expr.name : column.expr.type)],
  );
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

function ftsScopeFor(table: Fts5VirtualTable, row: Fts5Row, alias: string): ScopeRow {
  return {
    rowid: row.rowid,
    rowidName: "rowid",
    sourceTable: table.name,
    cells: table.columns.map((column) => ({
      table: alias,
      name: column,
      value: row.values.get(column.toLowerCase()) ?? null,
    })),
  };
}

function executeVirtualInsert(stmt: InsertStmt, env: ExecutionEnv): ResultSet {
  const any = env.state.getAnyVirtualTable(stmt.table);
  if (any.kind === "rtree") {
    const columnNames = stmt.columns ?? any.columns;
    const sourceRows = stmt.values
      ? stmt.values.map((items) => items.map((expr) => evalExpr(expr, env.createEvalContext())))
      : stmt.select
        ? resultValues(executeSelect({ ...stmt.select, with: stmt.with ?? stmt.select.with }, env))
        : [[]];
    let changes = 0;
    let last = env.state.lastInsertRowid;
    for (const source of sourceRows) {
      const values = new Map<string, SqlValue>();
      for (let i = 0; i < columnNames.length; i++) {
        values.set(columnNames[i]!.toLowerCase(), source[i] ?? null);
      }
      last = any.insert(values);
      changes++;
    }
    env.state.recordChange(changes, last);
    return valuesToResult([], [], changes, last);
  }
  if (any.kind !== "fts5" && any.kind !== "fts3" && any.kind !== "fts4") {
    throw new SqliteError(`table ${stmt.table} may not be modified`, "misuse");
  }
  const table = any;
  const columnNames = stmt.columns ?? table.columns;
  for (const name of columnNames) {
    const lower = name.toLowerCase();
    if (lower === table.name.toLowerCase()) continue; // FTS special-command column
    if (lower === "rowid" || lower === "_rowid_" || lower === "oid") continue;
    if (!table.columns.some((column) => column.toLowerCase() === lower)) {
      throw new SqliteError(`table ${table.name} has no column named ${name}`, "no_such_column");
    }
  }
  const sourceRows = stmt.values
    ? stmt.values.map((items) => items.map((expr) => evalExpr(expr, env.createEvalContext())))
    : stmt.select
      ? resultValues(executeSelect({ ...stmt.select, with: stmt.with ?? stmt.select.with }, env))
      : [[]];
  const { changes, lastInsertRowid } = executeFtsInsert(table, columnNames, sourceRows, env);
  env.state.recordChange(changes, lastInsertRowid);
  return valuesToResult([], [], changes, lastInsertRowid);
}

function executeVirtualUpdate(stmt: UpdateStmt, env: ExecutionEnv): ResultSet {
  if (stmt.from) throw new SqliteError("UPDATE FROM is not supported", "unsupported");
  const any = env.state.getAnyVirtualTable(stmt.table);
  if (any.kind === "rtree") {
    const alias = stmt.alias ?? stmt.table;
    const candidates = any.scan().filter((row) => {
      if (!stmt.where) return true;
      const scope: ScopeRow = {
        rowid: row.rowid,
        rowidName: "rowid",
        sourceTable: any.name,
        cells: any.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      };
      return isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) === true;
    });
    let changes = 0;
    for (const row of candidates) {
      const updates = new Map<string, SqlValue>();
      const scope: ScopeRow = {
        rowid: row.rowid,
        cells: any.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      };
      for (const item of stmt.set) {
        if (item.columns.length !== 1)
          throw new SqliteError("multi-column SET is not supported on virtual tables", "unsupported");
        updates.set(item.columns[0]!.toLowerCase(), evalExpr(item.expr, env.createEvalContext(scope)));
      }
      any.update(row.rowid, updates);
      changes++;
    }
    env.state.recordChange(changes);
    return valuesToResult([], [], changes, env.state.lastInsertRowid);
  }
  if (any.kind !== "fts5" && any.kind !== "fts3" && any.kind !== "fts4") {
    throw new SqliteError(`table ${stmt.table} may not be modified`, "misuse");
  }
  const table = any;
  const alias = stmt.alias ?? stmt.table;
  const candidates: Rowid[] = [];
  for (const row of table.scan()) {
    const scope = ftsScopeFor(table, row, alias);
    if (stmt.where && isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) !== true) continue;
    candidates.push(row.rowid);
  }
  let changes = 0;
  for (const rowid of candidates) {
    const row = table.rows.get(rowid)!;
    const scope = ftsScopeFor(table, row, alias);
    const updates = evaluateFtsSet(stmt.set, table, env.createEvalContext(scope));
    executeFtsUpdate(table, updates, [rowid]);
    changes++;
  }
  env.state.recordChange(changes);
  return valuesToResult([], [], changes, env.state.lastInsertRowid);
}

function executeVirtualDelete(stmt: DeleteStmt, env: ExecutionEnv): ResultSet {
  const any = env.state.getAnyVirtualTable(stmt.table);
  if (any.kind === "rtree") {
    const alias = stmt.alias ?? stmt.table;
    const selected = any.scan().filter((row) => {
      if (!stmt.where) return true;
      const scope: ScopeRow = {
        rowid: row.rowid,
        cells: any.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      };
      return isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope))) === true;
    });
    let changes = 0;
    for (const row of selected) {
      any.delete(row.rowid);
      changes++;
    }
    env.state.recordChange(changes);
    return valuesToResult([], [], changes, env.state.lastInsertRowid);
  }
  if (any.kind !== "fts5" && any.kind !== "fts3" && any.kind !== "fts4") {
    throw new SqliteError(`table ${stmt.table} may not be modified`, "misuse");
  }
  const table = any;
  const alias = stmt.alias ?? stmt.table;
  const selected = table.scan().filter((row) => {
    if (!stmt.where) return true;
    return isTruthySql(evalExpr(stmt.where, env.createEvalContext(ftsScopeFor(table, row, alias)))) === true;
  });
  const changes = executeFtsDelete(
    table,
    selected.map((row) => row.rowid),
  );
  env.state.recordChange(changes);
  return valuesToResult([], [], changes, env.state.lastInsertRowid);
}

function evaluateFtsSet(
  items: SetItem[],
  table: Fts5VirtualTable,
  ctx: ReturnType<ExecutionEnv["createEvalContext"]>,
): Map<string, SqlValue> {
  const updates = new Map<string, SqlValue>();
  for (const item of items) {
    if (item.columns.length !== 1)
      throw new SqliteError("multi-column SET is not supported on virtual tables", "unsupported");
    const name = item.columns[0]!;
    if (!table.columns.some((column) => column.toLowerCase() === name.toLowerCase())) {
      throw new SqliteError(`no such column: ${name}`, "no_such_column");
    }
    updates.set(normalizeColumnName(name), evalExpr(item.expr, ctx));
  }
  return updates;
}

function asExplicitRowid(value: SqlValue): Rowid | undefined {
  if (value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new SqliteError("datatype mismatch", "datatype_mismatch", "SQLITE_MISMATCH");
}
