import type { Expr } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import { isTruthySql, type SqlValue } from "../types/value.ts";
import type { ExecutionEnv } from "./env.ts";
import { emptyResult, type ResultSet, valuesToResult } from "./result.ts";

export function executePragma(name: string, expr: Expr | null, env: ExecutionEnv): ResultSet {
  const key = name.toLowerCase();
  switch (key) {
    case "foreign_keys":
      return pragmaForeignKeys(expr, env);
    case "table_info":
      return pragmaTableInfo(expr, env, false);
    case "table_xinfo":
      return pragmaTableInfo(expr, env, true);
    case "index_list":
      return pragmaIndexList(expr, env);
    case "index_info":
      return pragmaIndexInfo(expr, env);
    case "foreign_key_list":
      return pragmaForeignKeyList(expr, env);
    case "database_list":
      return pragmaDatabaseList(env);
    case "user_version":
      return pragmaIntVersion("user_version", expr, env, "userVersion");
    case "schema_version":
      return pragmaIntVersion("schema_version", expr, env, "schemaVersion");
    default:
      return emptyResult(0, env.state.lastInsertRowid);
  }
}

function pragmaForeignKeys(expr: Expr | null, env: ExecutionEnv): ResultSet {
  if (expr === null) {
    return valuesToResult(["foreign_keys"], [[env.state.foreignKeysEnabled ? 1 : 0]], 0, env.state.lastInsertRowid);
  }
  const value = pragmaValue(expr, env);
  if (!env.transactions.inTransaction) env.state.foreignKeysEnabled = isTruthySql(value) === true;
  return emptyResult(0, env.state.lastInsertRowid);
}

function pragmaTableInfo(expr: Expr | null, env: ExecutionEnv, xinfo: boolean): ResultSet {
  const tableName = pragmaTableArg(expr, env);
  const table = env.state.tables.get(tableName.toLowerCase());
  if (!table) return emptyResult(0, env.state.lastInsertRowid);
  const columns = xinfo
    ? ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"]
    : ["cid", "name", "type", "notnull", "dflt_value", "pk"];
  const rows: SqlValue[][] = table.columns.map((column, cid) => {
    const pkIndex = table.columns.filter((c) => c.primaryKey).findIndex((c) => c.name === column.name);
    const pk = column.primaryKey ? (pkIndex >= 0 ? pkIndex + 1 : 1) : 0;
    const dflt = column.defaultExpr ? defaultLiteral(column.defaultExpr) : null;
    const base: SqlValue[] = [cid, column.name, column.typeName ?? "", column.notNull ? 1 : 0, dflt, pk];
    if (xinfo) {
      let hidden = 0;
      if (column.generated?.stored) hidden = 2;
      else if (column.generated) hidden = 2;
      // SQLite: hidden=2 for VIRTUAL generated, hidden=3 for STORED in some versions; use 2 for generated
      if (column.generated && !column.generated.stored) hidden = 2;
      if (column.generated?.stored) hidden = 3;
      base.push(hidden);
    }
    return base;
  });
  return valuesToResult(columns, rows, 0, env.state.lastInsertRowid);
}

function defaultLiteral(expr: Expr): SqlValue {
  if (expr.type === "literal")
    return typeof expr.value === "string" ? `'${expr.value.replace(/'/g, "''")}'` : expr.value;
  if (expr.type === "null") return "NULL";
  return null;
}

function pragmaIndexList(expr: Expr | null, env: ExecutionEnv): ResultSet {
  const tableName = pragmaTableArg(expr, env);
  const table = env.state.tables.get(tableName.toLowerCase());
  if (!table) return emptyResult(0, env.state.lastInsertRowid);
  const rows: SqlValue[][] = [];
  let seq = 0;
  for (const name of table.indexes) {
    const index = env.state.indexes.get(name.toLowerCase());
    if (!index) continue;
    rows.push([seq++, index.name, index.unique ? 1 : 0, "c", 0]);
  }
  return valuesToResult(["seq", "name", "unique", "origin", "partial"], rows, 0, env.state.lastInsertRowid);
}

function pragmaIndexInfo(expr: Expr | null, env: ExecutionEnv): ResultSet {
  const indexName = pragmaTableArg(expr, env);
  const index = env.state.indexes.get(indexName.toLowerCase());
  if (!index) return emptyResult(0, env.state.lastInsertRowid);
  const table = env.state.getTable(index.tableName);
  const rows = index.columns.map((column, seqno) => {
    const cid = table.columns.findIndex((c) => c.name.toLowerCase() === column.name.toLowerCase());
    return [seqno, cid, column.name] as SqlValue[];
  });
  return valuesToResult(["seqno", "cid", "name"], rows, 0, env.state.lastInsertRowid);
}

function pragmaForeignKeyList(expr: Expr | null, env: ExecutionEnv): ResultSet {
  const tableName = pragmaTableArg(expr, env);
  const table = env.state.tables.get(tableName.toLowerCase());
  if (!table) return emptyResult(0, env.state.lastInsertRowid);
  const rows: SqlValue[][] = [];
  let id = 0;
  for (const constraint of table.constraints) {
    if (constraint.type !== "foreign_key") continue;
    const refColumns =
      constraint.refColumns ??
      env.state.tables
        .get(constraint.refTable.toLowerCase())
        ?.columns.filter((c) => c.primaryKey)
        .map((c) => c.name) ??
      [];
    constraint.columns.forEach((column, seq) => {
      rows.push([
        id,
        seq,
        constraint.refTable,
        column,
        refColumns[seq] ?? null,
        constraint.onUpdate ?? "NO ACTION",
        constraint.onDelete ?? "NO ACTION",
        "NONE",
      ]);
    });
    id++;
  }
  return valuesToResult(
    ["id", "seq", "table", "from", "to", "on_update", "on_delete", "match"],
    rows,
    0,
    env.state.lastInsertRowid,
  );
}

function pragmaDatabaseList(env: ExecutionEnv): ResultSet {
  const rows: SqlValue[][] = [[0, "main", ""]];
  let seq = 2;
  for (const [name, attached] of env.state.attached) {
    const file = attached.filename === ":memory:" ? "" : attached.filename;
    rows.push([seq++, name, file]);
  }
  return valuesToResult(["seq", "name", "file"], rows, 0, env.state.lastInsertRowid);
}

function pragmaIntVersion(
  label: string,
  expr: Expr | null,
  env: ExecutionEnv,
  field: "userVersion" | "schemaVersion",
): ResultSet {
  if (expr === null) {
    return valuesToResult([label], [[env.state[field]]], 0, env.state.lastInsertRowid);
  }
  const value = pragmaValue(expr, env);
  const num =
    typeof value === "number"
      ? Math.trunc(value)
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string"
          ? Number.parseInt(value, 10)
          : 0;
  if (field === "userVersion") env.state.userVersion = Number.isFinite(num) ? num : 0;
  else env.state.schemaVersion = Number.isFinite(num) ? num : 0;
  return emptyResult(0, env.state.lastInsertRowid);
}

function pragmaTableArg(expr: Expr | null, env: ExecutionEnv): string {
  if (!expr) throw new SqliteError("missing pragma argument", "misuse");
  if (expr.type === "column" && expr.table === null) return expr.name;
  if (expr.type === "literal" && typeof expr.value === "string") return expr.value;
  const value = evalExpr(expr, env.createEvalContext());
  if (typeof value === "string") return value;
  throw new SqliteError("invalid pragma argument", "misuse");
}

function pragmaValue(expr: Expr, env: ExecutionEnv): SqlValue {
  if (expr.type === "column" && expr.table === null) {
    const keyword = expr.name.toLowerCase();
    if (keyword === "on" || keyword === "true" || keyword === "yes") return 1;
    if (keyword === "off" || keyword === "false" || keyword === "no") return 0;
    return expr.name;
  }
  return evalExpr(expr, env.createEvalContext());
}
