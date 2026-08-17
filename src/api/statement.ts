import type { Statement as AstStatement } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { ExecutionEnv } from "../executor/env.ts";
import { executeStatement } from "../executor/execute.ts";
import type { ResultSet } from "../executor/result.ts";
import { tokenize } from "../lexer/tokenize.ts";
import type { Database } from "./database.ts";

export class Statement {
  private bound: unknown[] = [];
  private namedPlan: ReturnType<typeof planNamedParameters> | null = null;
  private env: ExecutionEnv | null = null;

  constructor(
    private readonly database: Database,
    private readonly sql: string,
    private readonly statements: AstStatement[],
  ) {}

  bind(...params: unknown[]): Statement {
    this.bound = [...params];
    return this;
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.execute(params.length > 0 ? params : this.bound, { named: false });
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  all<T>(...params: unknown[]): T[] {
    return this.execute(params.length > 0 ? params : this.bound, { named: true }).rows as T[];
  }

  /** Full result including column names (needed for empty result-set metadata). */
  result(...params: unknown[]): ResultSet {
    return this.execute(params.length > 0 ? params : this.bound, { named: true });
  }

  get<T>(...params: unknown[]): T | undefined {
    return this.execute(params.length > 0 ? params : this.bound, { named: true, maxRows: 1 }).rows[0] as T | undefined;
  }

  private execute(params: unknown[], options?: { named?: boolean; maxRows?: number }): ResultSet {
    this.database.assertOpen();
    if (this.statements.length === 0) throw new SqliteError("empty statement", "misuse");
    const env = this.obtainEnv(params);
    env.maxRows = options?.maxRows ?? Number.POSITIVE_INFINITY;
    env.includeNamedRows = options?.named !== false;
    env.includeValues = true;
    this.bindNamed(env, params);
    let result: ResultSet | undefined;
    let lastQuery: ResultSet | undefined;
    for (const statement of this.statements) {
      result = executeStatement(statement, env);
      if (result.columns.length > 0) lastQuery = result;
    }
    return lastQuery ?? result!;
  }

  private obtainEnv(params: unknown[]): ExecutionEnv {
    if (this.env) {
      this.env.reset(params);
      this.env.hooks.now = this.database.now;
      this.env.hooks.random = () => this.database.prng.nextSqliteRandom();
      this.env.hooks.randomU64 = () => this.database.prng.nextU64();
      return this.env;
    }
    this.env = new ExecutionEnv(this.database.state, this.database.transactions, params, undefined, {
      now: this.database.now,
      random: () => this.database.prng.nextSqliteRandom(),
      randomU64: () => this.database.prng.nextU64(),
    });
    return this.env;
  }

  private bindNamed(env: ExecutionEnv, params: readonly unknown[]): void {
    this.namedPlan ??= planNamedParameters(this.sql);
    for (const item of this.namedPlan.named) {
      if (item.slot <= params.length) env.setNamed(item.name, params[item.slot - 1]);
    }
  }
}

interface NamedPlan {
  named: { name: string; slot: number }[];
}

function planNamedParameters(sql: string): NamedPlan {
  const tokens = tokenize(sql);
  let nextSlot = 1;
  const namedSlots = new Map<string, number>();
  const named: { name: string; slot: number }[] = [];
  for (const token of tokens) {
    if (token.kind === "PARAM_POS") {
      if (token.index !== undefined) nextSlot = Math.max(nextSlot, token.index + 1);
      else nextSlot++;
    } else if (token.kind === "PARAM_NAMED") {
      const name = token.value.toLowerCase();
      let slot = namedSlots.get(name);
      if (slot === undefined) {
        slot = nextSlot++;
        namedSlots.set(name, slot);
        named.push({ name, slot });
      }
    }
  }
  return { named };
}

export function bindNamedParameters(env: ExecutionEnv, sql: string, params: readonly unknown[]): void {
  const plan = planNamedParameters(sql);
  for (const item of plan.named) {
    if (item.slot <= params.length) env.setNamed(item.name, params[item.slot - 1]);
  }
}
