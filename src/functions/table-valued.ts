import type { Expr } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import type { ExecutionEnv, ScopeRow } from "../executor/env.ts";
import { toInteger, type SqlValue } from "../types/value.ts";

export interface TableValuedResult {
  columns: string[];
  rows: ScopeRow[];
}

type TableValuedFn = (args: SqlValue[], alias: string | null, env: ExecutionEnv) => TableValuedResult;

const registry = new Map<string, TableValuedFn>();

registry.set("generate_series", (args, alias) => {
  if (args.length < 2 || args.length > 3) {
    throw new SqliteError("wrong number of arguments to function generate_series()", "misuse");
  }
  const start = toInteger(args[0] ?? null);
  const stop = toInteger(args[1] ?? null);
  const step = args.length === 3 ? toInteger(args[2] ?? null) : 1n;
  if (start === null || stop === null || step === null) {
    throw new SqliteError("datatype mismatch", "datatype_mismatch");
  }
  if (step === 0n || step === 0) throw new SqliteError("step must not be zero", "misuse");
  const startN = typeof start === "bigint" ? start : BigInt(start);
  const stopN = typeof stop === "bigint" ? stop : BigInt(stop);
  const stepN = typeof step === "bigint" ? step : BigInt(step);
  const table = alias ?? "generate_series";
  const rows: ScopeRow[] = [];
  if (stepN > 0n) {
    for (let value = startN; value <= stopN; value += stepN) {
      rows.push({
        cells: [{ table, name: "value", value: safeInt(value) }],
      });
    }
  } else {
    for (let value = startN; value >= stopN; value += stepN) {
      rows.push({
        cells: [{ table, name: "value", value: safeInt(value) }],
      });
    }
  }
  return { columns: ["value"], rows };
});

function safeInt(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value;
}

export function evaluateTableFunction(
  name: string,
  args: Expr[],
  alias: string | null,
  env: ExecutionEnv,
): TableValuedResult {
  const fn = registry.get(name.toLowerCase());
  if (!fn) throw new SqliteError(`no such table-valued function: ${name}`, "no_such_table");
  const values = args.map((arg) => evalExpr(arg, env.createEvalContext()));
  return fn(values, alias, env);
}
