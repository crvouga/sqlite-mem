import type { Expr, FromItem, TableRef } from "../ast/nodes.ts";
import type { ExecutionEnv } from "../executor/env.ts";
import { evalExpr } from "../expressions/eval.ts";
import type { IndexInfo } from "../storage/database-state.ts";
import type { Row, Rowid } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { normalizeForCollation } from "../types/collation.ts";
import type { SqlValue } from "../types/value.ts";

export interface ConstEquality {
  table: string | null;
  column: string;
  valueExpr: Expr;
}

export function conjunctions(expr: Expr): Expr[] {
  if (expr.type === "binary" && expr.op === "AND") {
    return [...conjunctions(expr.left), ...conjunctions(expr.right)];
  }
  return [expr];
}

function isRowIndependentExpr(expr: Expr): boolean {
  return expr.type !== "column";
}

export function equalityAgainstConst(expr: Expr): ConstEquality | null {
  if (expr.type !== "binary" || (expr.op !== "=" && expr.op !== "==")) return null;
  if (expr.left.type === "column" && isRowIndependentExpr(expr.right)) {
    return { table: expr.left.table, column: expr.left.name, valueExpr: expr.right };
  }
  if (expr.right.type === "column" && isRowIndependentExpr(expr.left)) {
    return { table: expr.right.table, column: expr.right.name, valueExpr: expr.left };
  }
  return null;
}

function matchesTable(table: string | null, alias: string, tableName: string): boolean {
  if (table === null) return true;
  const key = table.toLowerCase();
  return key === alias.toLowerCase() || key === tableName.toLowerCase();
}

function isRowidName(name: string): boolean {
  const key = name.toLowerCase();
  return key === "rowid" || key === "_rowid_" || key === "oid";
}

/** Look up rows for a simple `FROM table WHERE ...` using PK or a covering equality index. */
export function tryIndexedTableRows(
  from: FromItem,
  where: Expr,
  env: ExecutionEnv,
): { table: Table; alias: string; rows: Row[] } | null {
  if (from.type !== "table") return null;
  return lookupTableRows(from, where, env);
}

export function lookupTableRows(
  from: TableRef,
  where: Expr,
  env: ExecutionEnv,
): { table: Table; alias: string; rows: Row[] } | null {
  const alias = from.alias ?? from.name;
  const qualified = from.schema ? `${from.schema}.${from.name}` : from.name;
  const db = env.state.databaseForSchema(from.schema, qualified);
  if (from.name.toLowerCase() === "sqlite_schema" || from.name.toLowerCase() === "sqlite_master") return null;
  if (db.virtualTables.has(from.name.toLowerCase()) || db.views.has(from.name.toLowerCase())) return null;
  if (env.ctes.has(from.name.toLowerCase())) return null;

  let table: Table;
  try {
    table = db.getTable(from.name);
  } catch {
    return null;
  }

  const equalities = conjunctions(where)
    .map(equalityAgainstConst)
    .filter((item): item is ConstEquality => item !== null)
    .filter((item) => matchesTable(item.table, alias, table.name));
  if (equalities.length === 0) return null;

  const evalConst = (expr: Expr): SqlValue | undefined => {
    try {
      return evalExpr(expr, env.createEvalContext(null));
    } catch {
      return undefined;
    }
  };

  const resolved: { table: string | null; column: string; value: SqlValue }[] = [];
  for (const eq of equalities) {
    const value = evalConst(eq.valueExpr);
    if (value === undefined) continue;
    resolved.push({ table: eq.table, column: eq.column, value });
  }
  if (resolved.length === 0) return null;

  const pk = table.integerPkColumn();
  for (const eq of resolved) {
    const col = eq.column.toLowerCase();
    if (isRowidName(eq.column) || (pk && col === pk.name.toLowerCase())) {
      const row = table.getByKey(eq.value);
      if (row) return { table, alias, rows: [row] };
      if (eq.value === null || typeof eq.value === "number" || typeof eq.value === "bigint") {
        return { table, alias, rows: [] };
      }
      return null;
    }
  }

  const byColumn = new Map<string, SqlValue>();
  for (const eq of resolved) byColumn.set(eq.column.toLowerCase(), eq.value);

  let best: { rowids: readonly Rowid[] } | null = null;
  for (const indexName of table.indexes) {
    const index = db.indexes.get(indexName.toLowerCase());
    if (!index || index.where) continue;
    const prefix: SqlValue[] = [];
    for (const column of index.columns) {
      const value = byColumn.get(column.name.toLowerCase());
      if (value === undefined) break;
      prefix.push(normalizeForCollation(value, column.collate ?? "BINARY"));
    }
    if (prefix.length !== index.columns.length) continue;
    const rowids = index.store.lookup(prefix);
    best = { rowids };
    if (index.unique || rowids.length <= 1) break;
  }

  if (!best) return null;
  const rows: Row[] = [];
  for (const rowid of best.rowids) {
    const row = table.get(rowid);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => compareRowids(a.rowid, b.rowid));
  return { table, alias, rows };
}

function compareRowids(left: Rowid, right: Rowid): number {
  const a = typeof left === "bigint" ? left : BigInt(left);
  const b = typeof right === "bigint" ? right : BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface JoinProbe {
  table: Table;
  alias: string;
  lookup: (leftCellsValue: (table: string | null, name: string) => SqlValue) => Row[];
}

/** Equality join keys extracted from ON (column = column), for hash join when no index probe. */
export interface JoinEqualityKeys {
  /** Right-side column names in join-key order. */
  rightColumns: string[];
  /** Corresponding left-side (probe) column references. */
  leftKeys: { table: string | null; column: string }[];
}

export function tryJoinEqualityKeys(right: FromItem, on: Expr | null, env?: ExecutionEnv): JoinEqualityKeys | null {
  if (!on || right.type !== "table") return null;
  if (env) {
    const db = env.state.databaseForSchema(right.schema, right.schema ? `${right.schema}.${right.name}` : right.name);
    if (db.virtualTables.has(right.name.toLowerCase()) || db.views.has(right.name.toLowerCase())) return null;
    if (env.ctes.has(right.name.toLowerCase())) return null;
  }
  const alias = right.alias ?? right.name;
  const pairs: { rightColumn: string; leftTable: string | null; leftColumn: string }[] = [];
  for (const part of conjunctions(on)) {
    if (part.type !== "binary" || (part.op !== "=" && part.op !== "==")) continue;
    if (part.left.type !== "column" || part.right.type !== "column") continue;
    const leftOnRight = columnOnTable(part.left, alias, right.name);
    const rightOnRight = columnOnTable(part.right, alias, right.name);
    if (leftOnRight && !rightOnRight) {
      pairs.push({ rightColumn: part.left.name, leftTable: part.right.table, leftColumn: part.right.name });
    } else if (rightOnRight && !leftOnRight) {
      pairs.push({ rightColumn: part.right.name, leftTable: part.left.table, leftColumn: part.left.name });
    }
  }
  if (pairs.length === 0) return null;
  // Require the entire ON to be only equality conjunctions (no leftover predicates).
  const parts = conjunctions(on);
  if (parts.length !== pairs.length) return null;
  for (const part of parts) {
    if (part.type !== "binary" || (part.op !== "=" && part.op !== "==")) return null;
    if (part.left.type !== "column" || part.right.type !== "column") return null;
  }
  // rowid join keys need ScopeRow.rowid, not a regular cell — keep nested loop.
  if (pairs.some((pair) => isRowidName(pair.rightColumn))) return null;
  return {
    rightColumns: pairs.map((pair) => pair.rightColumn),
    leftKeys: pairs.map((pair) => ({ table: pair.leftTable, column: pair.leftColumn })),
  };
}

export function tryJoinProbe(right: FromItem, on: Expr | null, env: ExecutionEnv): JoinProbe | null {
  if (!on || right.type !== "table") return null;
  const alias = right.alias ?? right.name;
  const db = env.state.databaseForSchema(right.schema, right.schema ? `${right.schema}.${right.name}` : right.name);
  if (db.virtualTables.has(right.name.toLowerCase()) || db.views.has(right.name.toLowerCase())) return null;
  if (env.ctes.has(right.name.toLowerCase())) return null;
  let table: Table;
  try {
    table = db.getTable(right.name);
  } catch {
    return null;
  }

  const pairs: { rightColumn: string; leftTable: string | null; leftColumn: string }[] = [];
  for (const part of conjunctions(on)) {
    if (part.type !== "binary" || (part.op !== "=" && part.op !== "==")) continue;
    if (part.left.type !== "column" || part.right.type !== "column") continue;
    const leftOnRight = columnOnTable(part.left, alias, table.name);
    const rightOnRight = columnOnTable(part.right, alias, table.name);
    if (leftOnRight && !rightOnRight) {
      pairs.push({ rightColumn: part.left.name, leftTable: part.right.table, leftColumn: part.right.name });
    } else if (rightOnRight && !leftOnRight) {
      pairs.push({ rightColumn: part.right.name, leftTable: part.left.table, leftColumn: part.left.name });
    }
  }
  if (pairs.length === 0) return null;

  const pk = table.integerPkColumn();
  const pkPair = pairs.find(
    (pair) => isRowidName(pair.rightColumn) || (pk && pair.rightColumn.toLowerCase() === pk.name.toLowerCase()),
  );
  if (pkPair) {
    return {
      table,
      alias,
      lookup: (getLeft) => {
        const value = getLeft(pkPair.leftTable, pkPair.leftColumn);
        const row = table.getByKey(value);
        return row ? [row] : [];
      },
    };
  }

  for (const indexName of table.indexes) {
    const index: IndexInfo | undefined = db.indexes.get(indexName.toLowerCase());
    if (!index || index.where) continue;
    const prefixPairs: typeof pairs = [];
    for (const column of index.columns) {
      const pair = pairs.find((item) => item.rightColumn.toLowerCase() === column.name.toLowerCase());
      if (!pair) break;
      prefixPairs.push(pair);
    }
    if (prefixPairs.length !== index.columns.length) continue;
    return {
      table,
      alias,
      lookup: (getLeft) => {
        const values = prefixPairs.map((pair, i) =>
          normalizeForCollation(getLeft(pair.leftTable, pair.leftColumn), index.columns[i]?.collate ?? "BINARY"),
        );
        const rows: Row[] = [];
        for (const rowid of index.store.lookup(values)) {
          const row = table.get(rowid);
          if (row) rows.push(row);
        }
        rows.sort((a, b) => compareRowids(a.rowid, b.rowid));
        return rows;
      },
    };
  }
  return null;
}

function columnOnTable(column: { table: string | null; name: string }, alias: string, tableName: string): boolean {
  return column.table !== null && matchesTable(column.table, alias, tableName);
}
