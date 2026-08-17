import type {
  AggregateExpr,
  Expr,
  FromItem,
  OrderByItem,
  ResultColumn,
  SelectStmt,
  WindowExpr,
  WindowSpec,
} from "../ast/nodes.ts";
import { SqliteError, unsupported } from "../errors/index.ts";
import type { EvalContext } from "../expressions/context.ts";
import { evalExpr } from "../expressions/eval.ts";
import { buildSqliteMaster, buildSqliteSchema } from "../schema/catalog.ts";
import type { Table } from "../storage/table.ts";
import { compareWithCollation } from "../types/collation.ts";
import { applyAffinity, compareSql, isTruthySql, sqlValueEquals, toInteger, type SqlValue, type Affinity } from "../types/value.ts";
import { evaluateTableFunction } from "../functions/table-valued.ts";
import type { ExecutionEnv, ScopeRow } from "./env.ts";
import { resultValues, valuesToResult, type ResultSet } from "./result.ts";

function applyAffinityLocal(value: SqlValue, affinity: Affinity): SqlValue {
  return applyAffinity(value, affinity);
}

interface OutputRow {
  values: SqlValue[];
  scope: ScopeRow;
}

export function executeSelect(stmt: SelectStmt, env: ExecutionEnv, parent?: EvalContext): ResultSet {
  env.selectRunner = executeSelect;
  const savedCtes = new Map(env.ctes);
  try {
    if (stmt.with) executeWith(stmt, env, parent);
    const base = executeSelectCore({
      ...stmt,
      with: null,
      compound: null,
      orderBy: stmt.compound ? [] : stmt.orderBy,
      limit: stmt.compound ? null : stmt.limit,
    }, env, parent);
    if (!stmt.compound) return base;
    const right = executeSelect(stmt.compound.select, env, parent);
    if (base.columns.length !== right.columns.length) {
      throw new SqliteError("SELECTs to the left and right of compound operator do not have the same number of result columns", "other");
    }
    const leftRows = resultValues(base);
    const rightRows = resultValues(right);
    let rows: SqlValue[][];
    switch (stmt.compound.op) {
      case "UNION ALL": rows = [...leftRows, ...rightRows]; break;
      case "UNION": rows = uniqueRows([...leftRows, ...rightRows]); break;
      case "INTERSECT": rows = uniqueRows(leftRows).filter((row) => rightRows.some((other) => rowsEqual(row, other))); break;
      case "EXCEPT": rows = uniqueRows(leftRows).filter((row) => !rightRows.some((other) => rowsEqual(row, other))); break;
    }
    if (stmt.orderBy.length > 0) rows.sort((a, b) => compareCompoundRows(a, b, stmt.orderBy, base.columns));
    if (stmt.limit) {
      const ctx = env.createEvalContext(null, parent);
      const limitValue = toInteger(evalExpr(stmt.limit.limit, ctx));
      const offsetValue = stmt.limit.offset ? toInteger(evalExpr(stmt.limit.offset, ctx)) : 0;
      if (limitValue === null || offsetValue === null) throw new SqliteError("datatype mismatch", "datatype_mismatch");
      const offset = Math.max(0, Number(offsetValue));
      const limit = Number(limitValue);
      rows = rows.slice(offset, limit < 0 ? undefined : offset + limit);
    }
    return valuesToResult(base.columns, rows, 0, env.state.lastInsertRowid);
  } finally {
    env.ctes.clear();
    for (const [name, result] of savedCtes) env.ctes.set(name, result);
  }
}

function executeWith(stmt: SelectStmt, env: ExecutionEnv, parent?: EvalContext): void {
  for (const cte of stmt.with!.ctes) {
    const key = cte.name.toLowerCase();
    if (stmt.with!.recursive && referencesTable(cte.select, cte.name) && cte.select.compound) {
      const anchor = executeSelect({ ...cte.select, compound: null }, env, parent);
      const columns = cte.columns ?? anchor.columns;
      let accumulated = resultValues(anchor);
      let delta = accumulated;
      while (true) {
        env.ctes.set(key, valuesToResult(columns, delta));
        const nextResult = executeSelect(cte.select.compound.select, env, parent);
        const candidates = resultValues(nextResult);
        const additions = cte.select.compound.op === "UNION ALL"
          ? candidates
          : candidates.filter((row) => !accumulated.some((existing) => rowsEqual(existing, row)));
        if (additions.length === 0) break;
        accumulated = [...accumulated, ...additions];
        delta = additions;
      }
      env.ctes.set(key, valuesToResult(columns, accumulated));
    } else {
      const result = executeSelect(cte.select, env, parent);
      const columns = cte.columns ?? result.columns;
      env.ctes.set(key, valuesToResult(columns, resultValues(result)));
    }
  }
}

function executeSelectCore(stmt: SelectStmt, env: ExecutionEnv, parent?: EvalContext): ResultSet {
  let scopes = stmt.from ? scanFrom(stmt.from, env, parent) : [{ cells: [] }];
  if (stmt.where) {
    scopes = scopes.filter((scope) => isTruthySql(evalExpr(stmt.where!, env.createEvalContext(scope, parent))) === true);
  }

  const aggregate = stmt.groupBy.length > 0 ||
    stmt.columns.some((column) => column.type === "expr" && containsAggregate(column.expr)) ||
    (stmt.having !== null && containsAggregate(stmt.having));
  const groupBy = stmt.groupBy.map((expr) => {
    if (expr.type !== "literal" || typeof expr.value !== "number" || !Number.isInteger(expr.value)) return expr;
    const column = stmt.columns[expr.value - 1];
    if (!column || column.type !== "expr") throw new SqliteError(`${expr.value}th GROUP BY term out of range`, "other");
    return column.expr;
  });
  const groups = aggregate ? groupRows(scopes, groupBy, env, parent) : scopes.map((scope) => [scope]);
  const windowScopes = aggregate ? groups.map((group) => group[0] ?? { cells: [] }) : scopes;
  const sample = scopes[0] ?? (stmt.from ? { cells: shapeOf(stmt.from, env) } : undefined);
  if (scopes.length === 0 && sample) validateProjectedColumns(stmt, sample, env, parent);
  const columns = resultColumnNames(stmt.columns, sample);
  let output: OutputRow[] = [];

  for (const group of groups) {
    const scope = group[0] ?? { cells: [] };
    const ctx = env.createEvalContext(scope, parent);
    const values: SqlValue[] = [];
    for (const column of stmt.columns) {
      if (column.type === "star") {
        for (const cell of scope.cells) {
          if (
            (column.table !== null || !cell.hiddenByUsing) &&
            (column.table === null || cell.table?.toLowerCase() === column.table.toLowerCase())
          ) values.push(cell.value);
        }
      } else {
        values.push(evalGrouped(column.expr, ctx, group, env, parent, stmt.windows, windowScopes));
      }
    }
    if (stmt.having) {
      const aliases = new Map<string, SqlValue>();
      stmt.columns.forEach((column, index) => {
        if (column.type === "expr" && column.alias) aliases.set(column.alias.toLowerCase(), values[index] ?? null);
      });
      const havingCtx: EvalContext = {
        ...ctx,
        resolveColumn: (table, name) => {
          if (table === null && aliases.has(name.toLowerCase())) return aliases.get(name.toLowerCase()) ?? null;
          return ctx.resolveColumn(table, name);
        },
      };
      if (isTruthySql(evalGrouped(stmt.having, havingCtx, group, env, parent, stmt.windows, windowScopes)) !== true) continue;
    }
    output.push({ values, scope });
  }

  if (stmt.distinct) {
    output = output.filter((row, index, all) => all.findIndex((other) => rowsEqual(row.values, other.values)) === index);
  }
  if (stmt.orderBy.length > 0) {
    output.sort((left, right) => compareOutput(left, right, stmt.orderBy, columns, env, parent));
  }
  if (stmt.limit) {
    const ctx = env.createEvalContext(null, parent);
    const limitValue = toInteger(evalExpr(stmt.limit.limit, ctx));
    const offsetValue = stmt.limit.offset ? toInteger(evalExpr(stmt.limit.offset, ctx)) : 0;
    if (limitValue === null || offsetValue === null) throw new SqliteError("datatype mismatch", "datatype_mismatch");
    const offset = Math.max(0, Number(offsetValue));
    const limit = Number(limitValue);
    output = output.slice(offset, limit < 0 ? undefined : offset + limit);
  }
  return valuesToResult(columns, output.map((row) => row.values), 0, env.state.lastInsertRowid);
}

export function scanFrom(item: FromItem, env: ExecutionEnv, parent?: EvalContext): ScopeRow[] {
  if (item.type === "join") {
    const left = scanFrom(item.left, env, parent);
    const right = scanFrom(item.right, env, parent);
    const using = resolveUsingColumns(item, left, right, env);
    const leftShape = (left[0]?.cells ?? shapeOf(item.left, env));
    const rightShape = (right[0]?.cells ?? shapeOf(item.right, env)).map((cell) =>
      using?.some((name) => name.toLowerCase() === cell.name.toLowerCase())
        ? { ...cell, hiddenByUsing: true }
        : cell
    );
    const nullLeft = leftShape.map((cell) => ({ ...cell, value: null as SqlValue }));
    const nullRight = rightShape.map((cell) => ({ ...cell, value: null as SqlValue }));
    const result: ScopeRow[] = [];
    const matchedRight = new Set<number>();

    const joinOk = (lhs: ScopeRow, rhs: ScopeRow, joined: ScopeRow): boolean => {
      if (using) {
        return using.every((name) => {
          const l = lhs.cells.find((cell) => cell.name.toLowerCase() === name.toLowerCase())?.value ?? null;
          const r = rhs.cells.find((cell) => cell.name.toLowerCase() === name.toLowerCase())?.value ?? null;
          return l !== null && r !== null && sqlValueEquals(l, r);
        });
      }
      if (item.on) return isTruthySql(evalExpr(item.on, env.createEvalContext(joined, parent))) === true;
      return true;
    };

    for (const lhs of left) {
      let matched = false;
      right.forEach((rhs, rightIndex) => {
        const rightCells = using
          ? rhs.cells.map((cell) => using.some((name) => name.toLowerCase() === cell.name.toLowerCase())
            ? { ...cell, hiddenByUsing: true }
            : cell)
          : rhs.cells;
        const joined = { cells: [...lhs.cells, ...rightCells] };
        if (!joinOk(lhs, rhs, joined)) return;
        matched = true;
        matchedRight.add(rightIndex);
        result.push(joined);
      });
      if (!matched && (item.joinType === "LEFT" || item.joinType === "FULL")) {
        result.push({ cells: [...lhs.cells, ...nullRight] });
      }
    }

    if (item.joinType === "RIGHT" || item.joinType === "FULL") {
      right.forEach((rhs, rightIndex) => {
        if (matchedRight.has(rightIndex)) return;
        const rightCells = using
          ? rhs.cells.map((cell) => using.some((name) => name.toLowerCase() === cell.name.toLowerCase())
            ? { ...cell, hiddenByUsing: true }
            : cell)
          : rhs.cells;
        result.push({ cells: [...nullLeft, ...rightCells] });
      });
    }

    return result;
  }
  if (item.type === "subquery") {
    const result = executeSelect(item.select, env, parent);
    return resultValues(result).map((values) => ({
      cells: result.columns.map((name, index) => ({ table: item.alias, name, value: values[index] ?? null })),
    }));
  }
  if (item.type === "table_func") {
    return evaluateTableFunction(item.name, item.args, item.alias, env).rows;
  }

  const alias = item.alias ?? item.name;
  const qualified = item.schema ? `${item.schema}.${item.name}` : item.name;
  const db = env.state.databaseForSchema(item.schema, qualified);
  const cte = env.ctes.get(item.name.toLowerCase());
  if (cte) {
    return resultValues(cte).map((values) => ({
      cells: cte.columns.map((name, index) => ({ table: alias, name, value: values[index] ?? null })),
    }));
  }
  const view = db.views.get(item.name.toLowerCase());
  if (view) {
    const result = executeSelect(view.select, env, parent);
    const names = view.columns ?? result.columns;
    return resultValues(result).map((values) => ({
      cells: names.map((name, index) => ({ table: alias, name, value: values[index] ?? null })),
    }));
  }
  const virtual = db.virtualTables.get(item.name.toLowerCase());
  if (virtual) {
    return virtual.scan().map((row) => ({
      rowid: row.rowid,
      rowidName: "rowid",
      sourceTable: virtual.name,
      cells: virtual.columns.map((column) => ({
        table: alias,
        name: column,
        value: row.values.get(column.toLowerCase()) ?? null,
      })),
    }));
  }
  let table: Table;
  if (item.name.toLowerCase() === "sqlite_schema") table = buildSqliteSchema(db);
  else if (item.name.toLowerCase() === "sqlite_master") table = buildSqliteMaster(db);
  else table = db.getTable(item.name);
  const integerPkAlias = table.withoutRowid
    ? undefined
    : table.columns.find((column) =>
      column.primaryKey && column.typeName?.trim().toUpperCase() === "INTEGER"
    )?.name;
  return [...table.scan()].map((row) => {
    const baseCells = table.columns.filter((c) => !c.generated || c.generated.stored).map((column) => ({
      table: alias,
      name: column.name,
      value: row.values.get(column.name.toLowerCase()) ?? null,
      affinity: column.affinity,
      collate: column.collate,
    }));
    const cells = table.columns.map((column) => {
      if (column.generated && !column.generated.stored) {
        const ctx = env.createEvalContext({ cells: baseCells, sourceTable: table.name }, parent);
        return {
          table: alias,
          name: column.name,
          value: applyAffinityLocal(evalExpr(column.generated.expr, ctx), column.affinity),
          affinity: column.affinity,
          collate: column.collate,
        };
      }
      return {
        table: alias,
        name: column.name,
        value: row.values.get(column.name.toLowerCase()) ?? null,
        affinity: column.affinity,
        collate: column.collate,
      };
    });
    return {
      ...(table.withoutRowid ? {} : { rowid: row.rowid }),
      rowidName: integerPkAlias ?? (table.withoutRowid ? undefined : "rowid"),
      sourceTable: table.name,
      cells,
    };
  });
}

function shapeOf(item: FromItem, env: ExecutionEnv): ScopeRow["cells"] {
  if (item.type === "join") {
    const left = shapeOf(item.left, env);
    const right = shapeOf(item.right, env);
    const using = resolveUsingFromShapes(item.using, left, right);
    return [
      ...left,
      ...right.map((cell) => using?.some((name) => name.toLowerCase() === cell.name.toLowerCase())
        ? { ...cell, hiddenByUsing: true }
        : cell),
    ];
  }
  if (item.type === "subquery") return resultColumnNames(item.select.columns).map((name) => ({ table: item.alias, name, value: null }));
  if (item.type === "table_func") {
    return evaluateTableFunction(item.name, item.args, item.alias, env).columns.map((name) => ({
      table: item.alias ?? item.name,
      name,
      value: null,
    }));
  }
  const alias = item.alias ?? item.name;
  const qualified = item.schema ? `${item.schema}.${item.name}` : item.name;
  const db = env.state.databaseForSchema(item.schema, qualified);
  const cte = env.ctes.get(item.name.toLowerCase());
  if (cte) return cte.columns.map((name) => ({ table: alias, name, value: null }));
  const view = db.views.get(item.name.toLowerCase());
  if (view) return (view.columns ?? resultColumnNames(view.select.columns)).map((name) => ({ table: alias, name, value: null }));
  const virtual = db.virtualTables.get(item.name.toLowerCase());
  if (virtual) return virtual.columns.map((name) => ({ table: alias, name, value: null }));
  const table = item.name.toLowerCase() === "sqlite_schema"
    ? buildSqliteSchema(db)
    : item.name.toLowerCase() === "sqlite_master"
      ? buildSqliteMaster(db)
      : db.getTable(item.name);
  return table.columns.map((column) => ({ table: alias, name: column.name, value: null, affinity: column.affinity }));
}

/** NATURAL JOIN uses an empty USING list as a sentinel; resolve shared column names at runtime. */
function resolveUsingColumns(
  item: Extract<FromItem, { type: "join" }>,
  left: ScopeRow[],
  right: ScopeRow[],
  env: ExecutionEnv,
): string[] | null {
  const leftCells = left[0]?.cells ?? shapeOf(item.left, env);
  const rightCells = right[0]?.cells ?? shapeOf(item.right, env);
  return resolveUsingFromShapes(item.using, leftCells, rightCells);
}

function resolveUsingFromShapes(
  using: string[] | null,
  leftCells: ScopeRow["cells"],
  rightCells: ScopeRow["cells"],
): string[] | null {
  if (using === null) return null;
  if (using.length > 0) return using;
  const rightNames = new Set(rightCells.map((cell) => cell.name.toLowerCase()));
  const common: string[] = [];
  const seen = new Set<string>();
  for (const cell of leftCells) {
    const key = cell.name.toLowerCase();
    if (rightNames.has(key) && !seen.has(key)) {
      seen.add(key);
      common.push(cell.name);
    }
  }
  return common;
}

function groupRows(rows: ScopeRow[], expressions: Expr[], env: ExecutionEnv, parent?: EvalContext): ScopeRow[][] {
  if (expressions.length === 0) return [rows];
  const groups: ScopeRow[][] = [];
  const keys: SqlValue[][] = [];
  for (const row of rows) {
    const key = expressions.map((expr) => evalExpr(expr, env.createEvalContext(row, parent)));
    const index = keys.findIndex((other) => rowsEqual(key, other));
    if (index < 0) {
      keys.push(key);
      groups.push([row]);
    } else groups[index]!.push(row);
  }
  return groups;
}

function evalGrouped(
  expr: Expr,
  ctx: EvalContext,
  group: ScopeRow[],
  env: ExecutionEnv,
  parent: EvalContext | undefined,
  namedWindows: SelectStmt["windows"],
  windowRows: ScopeRow[],
): SqlValue {
  return evalExpr(replaceSpecial(expr, (special) => {
    if (special.type === "aggregate") return aggregateValue(special, group, env, parent);
    return windowValue(special, group[0] ?? { cells: [] }, windowRows, env, parent, namedWindows);
  }), ctx);
}

function aggregateValue(expr: AggregateExpr, rows: ScopeRow[], env: ExecutionEnv, parent?: EvalContext): SqlValue {
  const accumulator = env.functions.createAggregate(expr.name);
  if (!accumulator) throw new SqliteError(`no such aggregate function: ${expr.name}`, "other");
  const seen: SqlValue[][] = [];
  for (const row of rows) {
    const ctx = env.createEvalContext(row, parent);
    if (expr.filter && isTruthySql(evalExpr(expr.filter, ctx)) !== true) continue;
    const args = expr.args === "*" ? [] : expr.args.map((arg) => evalExpr(arg, ctx));
    if (expr.distinct && seen.some((values) => rowsEqual(values, args))) continue;
    seen.push(args);
    accumulator.step(args);
  }
  return accumulator.finalize();
}

function windowValue(
  expr: WindowExpr,
  current: ScopeRow,
  rows: ScopeRow[],
  env: ExecutionEnv,
  parent: EvalContext | undefined,
  namedWindows: SelectStmt["windows"],
): SqlValue {
  const spec = resolveWindow(expr.window, namedWindows);
  const currentCtx = env.createEvalContext(current, parent);
  const partitionKey = spec.partitionBy.map((item) => evalExpr(item, currentCtx));
  const partition = rows.filter((row) => rowsEqual(
    partitionKey,
    spec.partitionBy.map((item) => evalExpr(item, env.createEvalContext(row, parent))),
  ));
  partition.sort((a, b) => compareScopes(a, b, spec.orderBy, env, parent));
  const index = Math.max(0, partition.indexOf(current));
  const orderKeys = partition.map((row) => spec.orderBy.map((item) => evalExpr(item.expr, env.createEvalContext(row, parent))));
  let defaultFrameEnd = index;
  if (spec.orderBy.length > 0) {
    while (defaultFrameEnd + 1 < partition.length) {
      const next = partition[defaultFrameEnd + 1];
      if (!next || compareScopes(current, next, spec.orderBy, env, parent) !== 0) break;
      defaultFrameEnd++;
    }
  }
  if (expr.func.type === "aggregate") {
    const [start, end] = frameBounds(spec, index, partition.length, currentCtx, defaultFrameEnd);
    return aggregateValue(expr.func, partition.slice(start, end + 1), env, parent);
  }
  const name = expr.func.name.toLowerCase();
  const args = expr.func.args === "*" ? [] : expr.func.args;
  const values = partition.map((row) => args.map((arg) => evalExpr(arg, env.createEvalContext(row, parent))));
  if (name === "row_number") return index + 1;
  if (name === "rank") {
    let first = index;
    while (first > 0 && rowsEqual(orderKeys[first]!, orderKeys[first - 1]!)) first--;
    return first + 1;
  }
  if (name === "dense_rank") {
    let rank = 1;
    for (let i = 1; i <= index; i++) if (!rowsEqual(orderKeys[i]!, orderKeys[i - 1]!)) rank++;
    return rank;
  }
  const evaluated = args.map((arg) => evalExpr(arg, currentCtx));
  if (name === "lag" || name === "lead") {
    const offset = Number(toInteger(evaluated[1] ?? 1) ?? 1);
    const target = name === "lag" ? index - offset : index + offset;
    return values[target]?.[0] ?? evaluated[2] ?? null;
  }
  const [start, end] = frameBounds(spec, index, partition.length, currentCtx, defaultFrameEnd);
  if (name === "first_value") return values[start]?.[0] ?? null;
  if (name === "last_value") return values[end]?.[0] ?? null;
  if (name === "nth_value") {
    const target = start + Number(toInteger(evaluated[1] ?? null) ?? 0) - 1;
    return target >= start && target <= end ? values[target]?.[0] ?? null : null;
  }
  throw new SqliteError(`no such window function: ${expr.func.name}`, "other");
}

function resolveWindow(spec: WindowSpec, namedWindows: SelectStmt["windows"], seen = new Set<string>()): WindowSpec {
  if (!spec.ref) return spec;
  const key = spec.ref.toLowerCase();
  if (seen.has(key)) throw new SqliteError(`circular window definition: ${spec.ref}`, "other");
  const named = namedWindows.find((item) => item.name.toLowerCase() === key);
  if (!named) throw new SqliteError(`no such window: ${spec.ref}`, "other");
  seen.add(key);
  const base = resolveWindow(named.spec, namedWindows, seen);
  return {
    partitionBy: spec.partitionBy.length ? spec.partitionBy : base.partitionBy,
    orderBy: spec.orderBy.length ? spec.orderBy : base.orderBy,
    frame: spec.frame ?? base.frame,
    ref: null,
  };
}

function frameBounds(
  spec: WindowSpec,
  index: number,
  length: number,
  ctx: EvalContext,
  defaultFrameEnd: number,
): [number, number] {
  if (!spec.frame) return [0, spec.orderBy.length > 0 ? defaultFrameEnd : Math.max(0, length - 1)];
  const bound = (item: WindowSpec["frame"] extends infer _ ? NonNullable<WindowSpec["frame"]>["start"] : never, start: boolean): number => {
    switch (item.kind) {
      case "unbounded_preceding": return 0;
      case "unbounded_following": return Math.max(0, length - 1);
      case "current_row": return index;
      case "preceding": return Math.max(0, index - Number(toInteger(evalExpr(item.expr, ctx)) ?? 0));
      case "following": return Math.min(Math.max(0, length - 1), index + Number(toInteger(evalExpr(item.expr, ctx)) ?? 0));
    }
  };
  return [bound(spec.frame.start, true), bound(spec.frame.end, false)];
}

function compareScopes(a: ScopeRow, b: ScopeRow, order: OrderByItem[], env: ExecutionEnv, parent?: EvalContext): number {
  for (const item of order) {
    const left = evalExpr(item.expr, env.createEvalContext(a, parent));
    const right = evalExpr(item.expr, env.createEvalContext(b, parent));
    const result = compareNullable(left, right, item, a);
    if (result !== 0) return result;
  }
  return 0;
}

function compareOutput(a: OutputRow, b: OutputRow, order: OrderByItem[], columns: string[], env: ExecutionEnv, parent?: EvalContext): number {
  for (const item of order) {
    const value = (row: OutputRow): SqlValue => {
      if (item.expr.type === "literal" && typeof item.expr.value === "number" && Number.isInteger(item.expr.value)) {
        return row.values[item.expr.value - 1] ?? null;
      }
      if (item.expr.type === "column" && item.expr.table === null) {
        const requestedName = item.expr.name.toLowerCase();
        const index = columns.findIndex((name) => name.toLowerCase() === requestedName);
        if (index >= 0) return row.values[index] ?? null;
      }
      return evalExpr(item.expr, env.createEvalContext(row.scope, parent));
    };
    const result = compareNullable(value(a), value(b), item, a.scope);
    if (result !== 0) return result;
  }
  return 0;
}

function compareNullable(left: SqlValue, right: SqlValue, item: OrderByItem, scope?: ScopeRow): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    const nullFirst = item.nulls ? item.nulls === "FIRST" : item.dir === "ASC";
    return (left === null ? -1 : 1) * (nullFirst ? 1 : -1);
  }
  let collation: string | null = null;
  if (item.expr.type === "collate") collation = item.expr.collation;
  else if (scope && item.expr.type === "column") {
    const key = item.expr.name.toLowerCase();
    const match = scope.cells.find((cell) =>
      cell.name.toLowerCase() === key &&
      (item.expr.type === "column" && (item.expr.table === null || cell.table?.toLowerCase() === item.expr.table.toLowerCase())),
    );
    collation = match?.collate ?? null;
  }
  const comparison = collation
    ? compareWithCollation(left, right, collation)
    : compareSql(left, right);
  return (comparison ?? 0) * (item.dir === "DESC" ? -1 : 1);
}

function resultColumnNames(columns: ResultColumn[], sample?: ScopeRow): string[] {
  const names: string[] = [];
  for (const column of columns) {
    if (column.type === "star") {
      for (const cell of sample?.cells ?? []) {
        if (
          (column.table !== null || !cell.hiddenByUsing) &&
          (column.table === null || cell.table?.toLowerCase() === column.table.toLowerCase())
        ) names.push(cell.name);
      }
    } else if (
      !column.alias &&
      column.expr.type === "column" &&
      ["rowid", "_rowid_", "oid"].includes(column.expr.name.toLowerCase()) &&
      sample?.rowidName
    ) {
      names.push(sample.rowidName);
    } else names.push(column.alias ?? expressionName(column.expr));
  }
  return names;
}

function compareCompoundRows(left: SqlValue[], right: SqlValue[], order: OrderByItem[], columns: string[]): number {
  for (const item of order) {
    let index = -1;
    if (item.expr.type === "literal" && typeof item.expr.value === "number" && Number.isInteger(item.expr.value)) {
      index = item.expr.value - 1;
    } else if (item.expr.type === "column" && item.expr.table === null) {
      const requested = item.expr.name.toLowerCase();
      index = columns.findIndex((name) => name.toLowerCase() === requested);
    }
    if (index < 0) throw new SqliteError("ORDER BY term does not match any column in the result set", "other");
    const result = compareNullable(left[index] ?? null, right[index] ?? null, item);
    if (result !== 0) return result;
  }
  return 0;
}

function validateProjectedColumns(stmt: SelectStmt, sample: ScopeRow, env: ExecutionEnv, parent?: EvalContext): void {
  const ctx = env.createEvalContext({ ...sample, rowid: 1, rowidName: sample.rowidName }, parent);
  const visit = (expr: Expr): void => {
    if (expr.type === "column") {
      if (expr.name !== "*") ctx.resolveColumn(expr.table, expr.name);
      return;
    }
    const recurse = (item: Expr) => visit(item);
    switch (expr.type) {
      case "unary": recurse(expr.expr); break;
      case "binary": recurse(expr.left); recurse(expr.right); break;
      case "between": recurse(expr.expr); recurse(expr.lower); recurse(expr.upper); break;
      case "in":
        recurse(expr.expr);
        if (Array.isArray(expr.values)) expr.values.forEach(recurse);
        break;
      case "like": recurse(expr.expr); recurse(expr.pattern); if (expr.escape) recurse(expr.escape); break;
      case "function":
      case "aggregate":
        if (expr.args !== "*") expr.args.forEach(recurse);
        if (expr.filter) recurse(expr.filter);
        break;
      case "window":
        if (expr.func.args !== "*") expr.func.args.forEach(recurse);
        break;
      case "case":
        if (expr.base) recurse(expr.base);
        expr.whens.forEach((branch) => { recurse(branch.when); recurse(branch.then); });
        if (expr.else) recurse(expr.else);
        break;
      case "cast":
      case "collate": recurse(expr.expr); break;
      case "row": expr.values.forEach(recurse); break;
    }
  };
  for (const column of stmt.columns) if (column.type === "expr") visit(column.expr);
}

function expressionName(expr: Expr): string {
  if (expr.type === "column") return expr.name;
  if (expr.type === "literal") {
    if (expr.value === null) return "NULL";
    if (expr.value instanceof Uint8Array) return `X'${Array.from(expr.value).map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}'`;
    return typeof expr.value === "string" ? `'${expr.value.replaceAll("'", "''")}'` : String(expr.value);
  }
  if (expr.type === "null") return "NULL";
  if (expr.type === "function" || expr.type === "aggregate") return `${expr.name.toLowerCase()}(${expr.args === "*" ? "*" : ""})`;
  return expr.type;
}

function replaceSpecial(expr: Expr, evaluate: (expr: AggregateExpr | WindowExpr) => SqlValue): Expr {
  if (expr.type === "aggregate" || expr.type === "window") return { type: "literal", value: evaluate(expr) };
  const recurse = (item: Expr) => replaceSpecial(item, evaluate);
  switch (expr.type) {
    case "unary": return { ...expr, expr: recurse(expr.expr) };
    case "binary": return { ...expr, left: recurse(expr.left), right: recurse(expr.right) };
    case "between": return { ...expr, expr: recurse(expr.expr), lower: recurse(expr.lower), upper: recurse(expr.upper) };
    case "in": return { ...expr, expr: recurse(expr.expr), values: Array.isArray(expr.values) ? expr.values.map(recurse) : expr.values };
    case "like": return { ...expr, expr: recurse(expr.expr), pattern: recurse(expr.pattern), escape: expr.escape && recurse(expr.escape) };
    case "function": return { ...expr, args: expr.args === "*" ? "*" : expr.args.map(recurse), filter: expr.filter && recurse(expr.filter) };
    case "case": return { ...expr, base: expr.base && recurse(expr.base), whens: expr.whens.map((item) => ({ when: recurse(item.when), then: recurse(item.then) })), else: expr.else && recurse(expr.else) };
    case "cast": return { ...expr, expr: recurse(expr.expr) };
    case "row": return { ...expr, values: expr.values.map(recurse) };
    case "collate": return { ...expr, expr: recurse(expr.expr) };
    default: return expr;
  }
}

function containsAggregate(expr: Expr): boolean {
  let found = false;
  replaceSpecial(expr, (special) => {
    if (special.type === "aggregate") found = true;
    return null;
  });
  return found;
}

function referencesTable(select: SelectStmt, name: string): boolean {
  const target = name.toLowerCase();
  const visit = (item: FromItem | null): boolean => {
    if (!item) return false;
    if (item.type === "table") return item.name.toLowerCase() === target;
    if (item.type === "join") return visit(item.left) || visit(item.right);
    return item.type === "subquery" ? referencesTable(item.select, name) : false;
  };
  return visit(select.from) || (select.compound ? referencesTable(select.compound.select, name) : false);
}

function rowsEqual(left: SqlValue[], right: SqlValue[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index] ?? null;
    return value === null && other === null || value !== null && other !== null && sqlValueEquals(value, other);
  });
}

function uniqueRows(rows: SqlValue[][]): SqlValue[][] {
  return rows.filter((row, index) => rows.findIndex((other) => rowsEqual(row, other)) === index);
}
