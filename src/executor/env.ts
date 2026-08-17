import type { SelectStmt } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { EvalContext } from "../expressions/context.ts";
import { defaultFunctionRegistry, type FunctionRegistry } from "../functions/registry.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { Rowid } from "../storage/row.ts";
import type { TransactionManager } from "../transactions/manager.ts";
import type { SqlValue } from "../types/value.ts";
import { canonicalizeNumber, storageClassOf, type Affinity } from "../types/value.ts";
import type { ResultSet } from "./result.ts";

export interface Cell {
  table: string | null;
  name: string;
  value: SqlValue;
  affinity?: Affinity;
  /** Right-hand duplicate of a column merged by JOIN ... USING. */
  hiddenByUsing?: boolean;
}

export interface ScopeRow {
  cells: Cell[];
  rowid?: Rowid;
  /** Output name of the rowid pseudo-column (INTEGER PRIMARY KEY alias when present). */
  rowidName?: string;
  sourceTable?: string;
}

export type SelectRunner = (stmt: SelectStmt, env: ExecutionEnv, parent?: EvalContext) => ResultSet;

export interface ExecutionHooks {
  now?: () => Date;
  random?: () => bigint;
  /** Raw xorshift64* output for `randomblob`. */
  randomU64?: () => bigint;
}

export class ExecutionEnv {
  readonly state: DatabaseState;
  readonly transactions: TransactionManager;
  readonly functions: FunctionRegistry;
  readonly positional: SqlValue[];
  readonly named: Map<string, SqlValue>;
  readonly ctes = new Map<string, ResultSet>();
  readonly hooks: ExecutionHooks;
  selectRunner?: SelectRunner;

  constructor(
    state: DatabaseState,
    transactions: TransactionManager,
    params: readonly unknown[] = [],
    functions: FunctionRegistry = defaultFunctionRegistry,
    hooks: ExecutionHooks = {},
  ) {
    this.state = state;
    this.transactions = transactions;
    this.functions = functions;
    this.hooks = hooks;
    this.positional = params.map(toSqlValue);
    this.named = new Map();
  }

  setNamed(name: string, value: unknown): void {
    this.named.set(name.toLowerCase(), toSqlValue(value));
  }

  createEvalContext(row: ScopeRow | null = null, parent?: EvalContext): EvalContext {
    const cells = row?.cells ?? [];
    const context: EvalContext = {
      parent,
      functions: this.functions,
      functionContext: {
        changes: () => this.state.changes,
        lastInsertRowid: () => this.state.lastInsertRowid,
        now: this.hooks.now,
        random: this.hooks.random,
        randomU64: this.hooks.randomU64,
      },
      resolveColumn: (table, name) => {
        const key = name.toLowerCase();
        const tableMatches = table === null || cells.some((cell) => cell.table?.toLowerCase() === table.toLowerCase());
        if (tableMatches && (key === "rowid" || key === "_rowid_" || key === "oid") && row?.rowid !== undefined) {
          return row.rowid;
        }
        const matches = cells.filter((cell) =>
          cell.name.toLowerCase() === key &&
          (table !== null || !cell.hiddenByUsing) &&
          (table === null || cell.table?.toLowerCase() === table.toLowerCase()),
        );
        if (matches.length === 0) throw new SqliteError(`no such column: ${table ? `${table}.` : ""}${name}`, "no_such_column");
        if (matches.length > 1 && table === null) throw new SqliteError(`ambiguous column name: ${name}`, "other");
        return matches[0]!.value;
      },
      resolveStorageClass: (table, name) => {
        const key = name.toLowerCase();
        const matches = cells.filter((cell) =>
          cell.name.toLowerCase() === key &&
          (table !== null || !cell.hiddenByUsing) &&
          (table === null || cell.table?.toLowerCase() === table.toLowerCase()),
        );
        if (matches.length === 0) throw new SqliteError(`no such column: ${table ? `${table}.` : ""}${name}`, "no_such_column");
        if (matches.length > 1 && table === null) throw new SqliteError(`ambiguous column name: ${name}`, "other");
        const cell = matches[0]!;
        return cell.affinity === "REAL" && typeof cell.value === "number"
          ? "real"
          : storageClassOf(cell.value);
      },
      getParameter: (name) => {
        if (typeof name === "number") {
          if (name < 1 || name > this.positional.length) throw new SqliteError(`binding parameter ${name} is not supplied`, "misuse");
          return this.positional[name - 1]!;
        }
        const value = this.named.get(name.toLowerCase());
        if (value === undefined && !this.named.has(name.toLowerCase())) {
          throw new SqliteError(`binding parameter :${name} is not supplied`, "misuse");
        }
        return value ?? null;
      },
      executeSelect: (select) => {
        if (!this.selectRunner) throw new SqliteError("select executor is not configured", "misuse");
        const result = this.selectRunner(select, this, context);
        return {
          columns: result.columns,
          rows: result.values?.map((row) => [...row])
            ?? result.rows.map((record) => result.columns.map((column) => record[column] ?? null)),
        };
      },
    };
    return context;
  }
}

export function toSqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SqliteError("only finite numbers can be bound", "datatype_mismatch");
    return canonicalizeNumber(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new SqliteError(`unsupported bind value: ${typeof value}`, "datatype_mismatch");
}
