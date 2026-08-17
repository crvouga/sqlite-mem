import type { BinaryOp, Expr, SelectStmt } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { castSqlValue } from "../functions/scalar.ts";
import { defaultFunctionRegistry } from "../functions/registry.ts";
import {
  coerceToNumber,
  compareSql,
  isTruthySql,
  sqlValueEquals,
  storageClassOf,
  toInteger,
  utf8Decode,
  type SqlValue,
} from "../types/value.ts";
import type { EvalContext } from "./context.ts";
import { globMatch, likeMatch } from "./like.ts";

function numberValue(value: SqlValue): number {
  return coerceToNumber(value) ?? 0;
}

function integerValue(value: SqlValue): bigint {
  const integer = toInteger(value);
  return typeof integer === "bigint" ? integer : BigInt(integer ?? 0);
}

function textValue(value: SqlValue): string {
  return value instanceof Uint8Array ? utf8Decode(value) : String(value);
}

function booleanValue(value: boolean): SqlValue {
  return value ? 1 : 0;
}

function executeSelect(ctx: EvalContext, select: SelectStmt): { columns: string[]; rows: SqlValue[][] } {
  if (!ctx.executeSelect) throw new SqliteError("subqueries are not available in this evaluation context", "misuse");
  return ctx.executeSelect(select);
}

function resolveColumn(ctx: EvalContext, table: string | null, name: string): SqlValue {
  try {
    return ctx.resolveColumn(table, name);
  } catch (error) {
    if (ctx.parent && error instanceof SqliteError && error.category === "no_such_column") {
      return resolveColumn(ctx.parent, table, name);
    }
    throw error;
  }
}

function sqlAnd(left: SqlValue, right: () => SqlValue): SqlValue {
  const leftTruth = isTruthySql(left);
  if (leftTruth === false) return 0;
  const rightTruth = isTruthySql(right());
  if (rightTruth === false) return 0;
  if (leftTruth === null || rightTruth === null) return null;
  return 1;
}

function sqlOr(left: SqlValue, right: () => SqlValue): SqlValue {
  const leftTruth = isTruthySql(left);
  if (leftTruth === true) return 1;
  const rightTruth = isTruthySql(right());
  if (rightTruth === true) return 1;
  if (leftTruth === null || rightTruth === null) return null;
  return 0;
}

function compareResult(op: BinaryOp, left: SqlValue, right: SqlValue): SqlValue {
  if (op === "IS" || op === "IS NOT") {
    const equal = left === null || right === null ? left === right : sqlValueEquals(left, right);
    return booleanValue(op === "IS" ? equal : !equal);
  }
  const comparison = compareSql(left, right);
  if (comparison === null) return null;
  switch (op) {
    case "=":
    case "==": return booleanValue(comparison === 0);
    case "!=":
    case "<>": return booleanValue(comparison !== 0);
    case "<": return booleanValue(comparison < 0);
    case "<=": return booleanValue(comparison <= 0);
    case ">": return booleanValue(comparison > 0);
    case ">=": return booleanValue(comparison >= 0);
    default: throw new SqliteError(`unsupported comparison operator: ${op}`, "unsupported");
  }
}

function evalBinary(op: BinaryOp, leftExpr: Expr, rightExpr: Expr, ctx: EvalContext): SqlValue {
  const left = evalExpr(leftExpr, ctx);
  if (op === "AND") return sqlAnd(left, () => evalExpr(rightExpr, ctx));
  if (op === "OR") return sqlOr(left, () => evalExpr(rightExpr, ctx));
  const right = evalExpr(rightExpr, ctx);

  if (["=", "==", "!=", "<>", "<", "<=", ">", ">=", "IS", "IS NOT"].includes(op)) {
    return compareResult(op, left, right);
  }
  if (op === "LIKE" || op === "NOT LIKE" || op === "GLOB" || op === "NOT GLOB") {
    if (left === null || right === null) return null;
    const matches = op.includes("LIKE")
      ? likeMatch(textValue(left), textValue(right))
      : globMatch(textValue(left), textValue(right));
    return booleanValue(op.startsWith("NOT") ? !matches : matches);
  }
  if (left === null || right === null) return null;
  switch (op) {
    case "+": return numberValue(left) + numberValue(right);
    case "-": return numberValue(left) - numberValue(right);
    case "*": return numberValue(left) * numberValue(right);
    case "/": {
      const divisor = numberValue(right);
      if (divisor === 0) return null;
      if (storageClassOf(left) === "integer" && storageClassOf(right) === "integer") {
        const quotient = integerValue(left) / integerValue(right);
        return quotient <= BigInt(Number.MAX_SAFE_INTEGER) && quotient >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(quotient)
          : quotient;
      }
      return numberValue(left) / divisor;
    }
    case "%": {
      const divisor = integerValue(right);
      if (divisor === 0n) return null;
      const remainder = integerValue(left) % divisor;
      return remainder <= BigInt(Number.MAX_SAFE_INTEGER) && remainder >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(remainder)
        : remainder;
    }
    case "||": return textValue(left) + textValue(right);
    case "&": return integerValue(left) & integerValue(right);
    case "|": return integerValue(left) | integerValue(right);
    case "<<": return integerValue(left) << integerValue(right);
    case ">>": return integerValue(left) >> integerValue(right);
    case "IN":
    case "NOT IN":
      throw new SqliteError(`${op} requires an IN expression node`, "misuse");
    case "MATCH":
      throw new SqliteError("unable to use function MATCH in the requested context", "unsupported");
    default:
      throw new SqliteError(`unsupported binary operator: ${op}`, "unsupported");
  }
}

function evalIn(left: SqlValue, values: SqlValue[], not: boolean): SqlValue {
  if (values.length === 0) return booleanValue(not);
  if (left === null) return null;
  let sawNull = false;
  for (const value of values) {
    if (value === null) {
      sawNull = true;
    } else if (compareSql(left, value) === 0) {
      return booleanValue(!not);
    }
  }
  if (sawNull) return null;
  return booleanValue(not);
}

export function evalExpr(expr: Expr, ctx: EvalContext): SqlValue {
  switch (expr.type) {
    case "literal": return expr.value;
    case "null": return null;
    case "column": return resolveColumn(ctx, expr.table, expr.name);
    case "parameter": return ctx.getParameter(expr.name);
    case "collate": return evalExpr(expr.expr, ctx);
    case "unary": {
      const value = evalExpr(expr.expr, ctx);
      if (expr.op === "NOT") {
        const truth = isTruthySql(value);
        return truth === null ? null : booleanValue(!truth);
      }
      if (value === null) return null;
      if (expr.op === "+") return numberValue(value);
      if (expr.op === "-") return -numberValue(value);
      return ~integerValue(value);
    }
    case "binary": return evalBinary(expr.op, expr.left, expr.right, ctx);
    case "between": {
      const value = evalExpr(expr.expr, ctx);
      const lower = compareResult(">=", value, evalExpr(expr.lower, ctx));
      const result = sqlAnd(lower, () => compareResult("<=", value, evalExpr(expr.upper, ctx)));
      if (result === null) return null;
      return expr.not ? booleanValue(result === 0) : result;
    }
    case "in": {
      const left = evalExpr(expr.expr, ctx);
      const values = Array.isArray(expr.values)
        ? expr.values.map((value) => evalExpr(value, ctx))
        : executeSelect(ctx, expr.values).rows.map((row) => row[0] ?? null);
      return evalIn(left, values, expr.not);
    }
    case "like": {
      const value = evalExpr(expr.expr, ctx);
      const pattern = evalExpr(expr.pattern, ctx);
      const escape = expr.escape === null ? null : evalExpr(expr.escape, ctx);
      if (value === null || pattern === null || escape === null && expr.escape !== null) return null;
      const match = expr.op === "LIKE"
        ? likeMatch(textValue(value), textValue(pattern), escape === null ? null : textValue(escape))
        : globMatch(textValue(value), textValue(pattern));
      return booleanValue(expr.not ? !match : match);
    }
    case "case": {
      if (expr.base === null) {
        for (const branch of expr.whens) {
          if (isTruthySql(evalExpr(branch.when, ctx)) === true) return evalExpr(branch.then, ctx);
        }
      } else {
        const base = evalExpr(expr.base, ctx);
        for (const branch of expr.whens) {
          if (compareSql(base, evalExpr(branch.when, ctx)) === 0) return evalExpr(branch.then, ctx);
        }
      }
      return expr.else === null ? null : evalExpr(expr.else, ctx);
    }
    case "cast": return castSqlValue(evalExpr(expr.expr, ctx), expr.typeName);
    case "function": {
      if (expr.args === "*") throw new SqliteError(`wrong number of arguments to function ${expr.name}()`, "misuse");
      if (
        expr.name.toLowerCase() === "typeof" &&
        expr.args.length === 1 &&
        expr.args[0]?.type === "column" &&
        ctx.resolveStorageClass
      ) {
        return ctx.resolveStorageClass(expr.args[0].table, expr.args[0].name);
      }
      const fn = (ctx.functions ?? defaultFunctionRegistry).lookupScalar(expr.name);
      if (!fn) throw new SqliteError(`no such function: ${expr.name}`, "other");
      return fn(expr.args.map((arg) => evalExpr(arg, ctx)), ctx.functionContext ?? {});
    }
    case "exists": {
      const exists = executeSelect(ctx, expr.select).rows.length > 0;
      return booleanValue(expr.not ? !exists : exists);
    }
    case "subquery": {
      const result = executeSelect(ctx, expr.select);
      if (result.columns.length > 1) throw new SqliteError("sub-select returns more than 1 column", "other");
      return result.rows[0]?.[0] ?? null;
    }
    case "aggregate":
      throw new SqliteError("aggregate expression requires aggregate evaluation", "misuse");
    case "window":
      throw new SqliteError("window expression requires window evaluation", "misuse");
    case "row":
      throw new SqliteError("row value cannot be used as a scalar value", "misuse");
  }
}
