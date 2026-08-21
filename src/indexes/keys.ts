import type { IndexedColumn } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { EvalContext } from "../expressions/context.ts";
import { evalExpr } from "../expressions/eval.ts";
import { defaultFunctionRegistry } from "../functions/registry.ts";
import type { IndexInfo } from "../storage/database-state.ts";
import { normalizeColumnName, type Row } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { normalizeForCollation } from "../types/collation.ts";
import type { Affinity, SqlValue } from "../types/value.ts";
import { isTruthySql } from "../types/value.ts";

/** Heap cells for evaluating index expressions / partial `WHERE` via `ExecutionEnv`. */
export function heapRowCells(
  table: Table,
  row: Row,
): Array<{ table: string; name: string; value: SqlValue; affinity: Affinity; collate: string | null }> {
  return table.columns.map((column) => ({
    table: table.name,
    name: column.name,
    value: table.cell(row, normalizeColumnName(column.name)),
    affinity: column.affinity,
    collate: column.collate,
  }));
}

/** Indexed-column values for one heap row (expression indexes included when `ctx` is set). */
export function indexKeyValues(
  columns: readonly IndexedColumn[],
  row: Row,
  ctx?: EvalContext | null,
  table?: Table,
): SqlValue[] {
  return columns.map((column) => {
    const raw =
      column.expr && ctx
        ? evalExpr(column.expr, ctx)
        : table
          ? table.cell(row, normalizeColumnName(column.name))
          : null;
    return normalizeForCollation(raw, column.collate ?? "BINARY");
  });
}

/** Rebuild `index.store` from `table` using the same keys as DML maintenance. */
export function rebuildIndexFromTable(index: IndexInfo, table: Table, ctxForRow: (row: Row) => EvalContext): void {
  index.store.clear();
  for (const row of table.scan()) {
    const ctx = ctxForRow(row);
    if (index.where && isTruthySql(evalExpr(index.where, ctx)) !== true) continue;
    index.store.insert(indexKeyValues(index.columns, row, ctx, table), row.rowid, index.unique);
  }
}

/** Snapshot / no-`ExecutionEnv` evaluator for index expressions / partial predicates. */
export function tableRowEvalContext(table: Table, row: Row): EvalContext {
  return {
    functions: defaultFunctionRegistry,
    resolveColumn: (qualifier, name) => {
      if (qualifier && qualifier.toLowerCase() !== table.name.toLowerCase()) {
        throw new SqliteError(`no such column: ${qualifier}.${name}`, "no_such_column");
      }
      const key = name.toLowerCase();
      if (key === "rowid" || key === "_rowid_" || key === "oid") return row.rowid;
      if (!table.hasColumn(key) && key !== "rowid") {
        throw new SqliteError(`no such column: ${name}`, "no_such_column");
      }
      return table.cell(row, key);
    },
    getParameter: () => {
      throw new SqliteError("parameters are not allowed in index predicates", "misuse");
    },
  };
}
