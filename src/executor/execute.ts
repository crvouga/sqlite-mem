import type { Statement } from "../ast/nodes.ts";
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
import { executePragma } from "./pragma.ts";
import { executeSelect } from "./select.ts";
import { executeAttach, executeDetach } from "./attach.ts";
import { executeCreateTrigger, executeDropTrigger } from "./triggers.ts";
import { executeCreateVirtualTable } from "./vtable.ts";

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
    case "create_trigger": return executeCreateTrigger(stmt, env);
    case "drop_trigger": return executeDropTrigger(stmt, env);
    case "create_virtual_table": return executeCreateVirtualTable(stmt, env);
    case "attach": return executeAttach(stmt, env);
    case "detach": return executeDetach(stmt, env);
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
