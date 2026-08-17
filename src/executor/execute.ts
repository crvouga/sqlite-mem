import type { Statement } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import { isTruthySql, type SqlValue } from "../types/value.ts";
import type { ExecutionEnv } from "./env.ts";
import {
  executeAlterTable,
  executeCreateIndex,
  executeCreateTable,
  executeCreateView,
  executeDropIndex,
  executeDropTable,
  executeDropView,
} from "./ddl.ts";
import { executeDelete, executeInsert, executeUpdate } from "./dml.ts";
import { emptyResult, valuesToResult, type ResultSet } from "./result.ts";
import { executeSelect } from "./select.ts";

export function executeStatement(stmt: Statement, env: ExecutionEnv): ResultSet {
  env.selectRunner = executeSelect;
  switch (stmt.type) {
    case "select": return executeSelect(stmt, env);
    case "insert": return executeInsert(stmt, env);
    case "update": return executeUpdate(stmt, env);
    case "delete": return executeDelete(stmt, env);
    case "create_table": return executeCreateTable(stmt, env);
    case "drop_table": return executeDropTable(stmt, env);
    case "alter_table": return executeAlterTable(stmt, env);
    case "create_index": return executeCreateIndex(stmt, env);
    case "drop_index": return executeDropIndex(stmt, env);
    case "create_view": return executeCreateView(stmt, env);
    case "drop_view": return executeDropView(stmt, env);
    case "begin":
      env.transactions.begin();
      return emptyResult(0, env.state.lastInsertRowid);
    case "commit":
      env.transactions.commit();
      return emptyResult(0, env.state.lastInsertRowid);
    case "rollback":
      env.transactions.rollback(stmt.savepoint ?? undefined);
      return emptyResult(0, env.state.lastInsertRowid);
    case "savepoint":
      env.transactions.savepoint(stmt.name);
      return emptyResult(0, env.state.lastInsertRowid);
    case "release":
      env.transactions.release(stmt.name);
      return emptyResult(0, env.state.lastInsertRowid);
    case "pragma": return executePragma(stmt.name, stmt.value, env);
    case "explain":
      return valuesToResult(
        stmt.queryPlan ? ["id", "parent", "notused", "detail"] : ["addr", "opcode", "p1", "p2", "p3", "p4", "p5", "comment"],
        stmt.queryPlan ? [[0, 0, 0, `EXECUTE ${stmt.statement.type.toUpperCase()}`]] : [[0, "Execute", 0, 0, 0, stmt.statement.type, 0, null]],
        0,
        env.state.lastInsertRowid,
      );
  }
}

function executePragma(name: string, expr: import("../ast/nodes.ts").Expr | null, env: ExecutionEnv): ResultSet {
  if (name.toLowerCase() !== "foreign_keys") throw new SqliteError(`unknown pragma: ${name}`, "other");
  if (expr === null) {
    return valuesToResult(["foreign_keys"], [[env.state.foreignKeysEnabled ? 1 : 0]], 0, env.state.lastInsertRowid);
  }
  let value: SqlValue;
  if (expr.type === "column" && expr.table === null) {
    const keyword = expr.name.toLowerCase();
    if (keyword === "on" || keyword === "true" || keyword === "yes") value = 1;
    else if (keyword === "off" || keyword === "false" || keyword === "no") value = 0;
    else value = expr.name;
  } else value = evalExpr(expr, env.createEvalContext());
  if (!env.transactions.inTransaction) env.state.foreignKeysEnabled = isTruthySql(value) === true;
  return emptyResult(0, env.state.lastInsertRowid);
}
