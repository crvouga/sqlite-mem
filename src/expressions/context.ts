import type { SelectStmt } from "../ast/nodes.ts";
import type { FunctionContext, FunctionRegistry } from "../functions/registry.ts";
import type { SqlValue } from "../types/value.ts";
import type { StorageClass } from "../types/value.ts";

export interface EvalContext {
  resolveColumn(table: string | null, name: string): SqlValue;
  resolveStorageClass?(table: string | null, name: string): StorageClass;
  getParameter(name: string | number): SqlValue;
  /** Execute a scalar, IN, or EXISTS subquery. */
  executeSelect?(select: SelectStmt): { columns: string[]; rows: SqlValue[][] };
  /** Context used to resolve correlated column references. */
  parent?: EvalContext;
  /** Optional per-database function registry and database hooks. */
  functions?: FunctionRegistry;
  functionContext?: FunctionContext;
}
