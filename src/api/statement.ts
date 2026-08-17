import type { Statement as AstStatement } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { ExecutionEnv } from "../executor/env.ts";
import { executeStatement } from "../executor/execute.ts";
import type { ResultSet } from "../executor/result.ts";
import { tokenize } from "../lexer/tokenize.ts";
import type { Database } from "./database.ts";

export class Statement {
  private bound: unknown[] = [];

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
    const result = this.execute(params.length > 0 ? params : this.bound);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  all<T>(...params: unknown[]): T[] {
    return this.execute(params.length > 0 ? params : this.bound).rows as T[];
  }

  get<T>(...params: unknown[]): T | undefined {
    return this.all<T>(...(params.length > 0 ? params : this.bound))[0];
  }

  private execute(params: unknown[]): ResultSet {
    this.database.assertOpen();
    if (this.statements.length === 0) throw new SqliteError("empty statement", "misuse");
    const env = new ExecutionEnv(
      this.database.state,
      this.database.transactions,
      params,
      undefined,
      {
        now: this.database.now,
        random: () => this.database.prng.nextSqliteRandom(),
        randomU64: () => this.database.prng.nextU64(),
      },
    );
    bindNamedParameters(env, this.sql, params);
    let result: ResultSet | undefined;
    let lastQuery: ResultSet | undefined;
    for (const statement of this.statements) {
      result = executeStatement(statement, env);
      if (result.columns.length > 0) lastQuery = result;
    }
    return lastQuery ?? result!;
  }
}

export function bindNamedParameters(env: ExecutionEnv, sql: string, params: readonly unknown[]): void {
  const tokens = tokenize(sql);
  let nextSlot = 1;
  const namedSlots = new Map<string, number>();
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
      }
      if (slot <= params.length) env.setNamed(name, params[slot - 1]);
    }
  }
}
