import type { Expr } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { IndexStore } from "../indexes/index.ts";
import type { Row, Rowid } from "../storage/row.ts";
import { normalizeColumnName } from "../storage/row.ts";
import type { ColumnInfo, Table } from "../storage/table.ts";
import type { SqlValue } from "../types/value.ts";
import { isTruthySql } from "../types/value.ts";

export type CheckEvaluator = (expr: Expr, row: Row) => SqlValue;

export function checkNotNull(columns: readonly ColumnInfo[], row: Row, tableName = "table"): void {
  for (const column of columns) {
    if (!column.notNull) continue;
    if ((row.values.get(normalizeColumnName(column.name)) ?? null) === null) {
      throw new SqliteError(
        `NOT NULL constraint failed: ${tableName}.${column.name}`,
        "constraint_notnull",
        "SQLITE_CONSTRAINT_NOTNULL",
      );
    }
  }
}

export function checkPrimaryKey(columns: readonly ColumnInfo[], row: Row, tableName = "table"): void {
  for (const column of columns) {
    if (!column.primaryKey) continue;
    if ((row.values.get(normalizeColumnName(column.name)) ?? null) === null) {
      throw new SqliteError(
        `PRIMARY KEY constraint failed: ${tableName}.${column.name}`,
        "constraint_primary",
        "SQLITE_CONSTRAINT_PRIMARYKEY",
      );
    }
  }
}

export function checkUnique(index: IndexStore, values: readonly SqlValue[], rowid?: Rowid): void {
  index.checkUnique(values, rowid);
}

export function checkExpressions(
  expressions: readonly Expr[],
  row: Row,
  evaluate: CheckEvaluator,
  constraintName = "CHECK",
): void {
  for (const expression of expressions) {
    const result = evaluate(expression, row);
    if (result !== null && isTruthySql(result) === false) {
      throw new SqliteError(
        `CHECK constraint failed: ${constraintName}`,
        "constraint_check",
        "SQLITE_CONSTRAINT_CHECK",
      );
    }
  }
}

export function checkTableConstraints(table: Table, row: Row, evaluate: CheckEvaluator): void {
  checkNotNull(table.columns, row, table.name);
  checkPrimaryKey(table.columns, row, table.name);
  for (const constraint of table.constraints) {
    if (constraint.type !== "check") continue;
    checkExpressions([constraint.expr], row, evaluate, constraint.name ?? table.name);
  }
}
