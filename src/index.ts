/**
 * @packageDocumentation
 * Pure TypeScript in-memory SQLite. Import {@link Database} to get started.
 *
 * Deterministic by default (`random()` seed `1`, `'now'` = `2000-01-01T00:00:00.000Z`).
 * Zero WASM, native bindings, or filesystem.
 *
 * @example
 * ```ts
 * import { Database } from "@crvouga/sqlite-mem";
 *
 * const db = new Database();
 * db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
 * db.exec("INSERT INTO t (name) VALUES (?)", ["Ada"]);
 * const rows = db.query<{ id: number; name: string }>("SELECT * FROM t");
 * ```
 *
 * @module
 */
export * from "./api/database.ts";
export { Statement, type RunResult } from "./api/statement.ts";
export type { Expr } from "./ast/nodes.ts";
export { SqliteError, type ErrorCategory } from "./errors/index.ts";
export type { ResultSet } from "./executor/result.ts";
export type { EvalContext } from "./expressions/context.ts";
export { evalExpr } from "./expressions/eval.ts";
export { globMatch, likeMatch } from "./expressions/like.ts";
export { tokenize, type Token, type TokenKind } from "./lexer/tokenize.ts";
export { parse, type ParsedStatement } from "./parser/index.ts";
export {
  type Clock,
  DEFAULT_DATABASE_SEED,
  DEFAULT_NOW,
  deriveSeed,
  fixedClock,
  Prng,
  resolveClock,
} from "./runtime/index.ts";
export {
  type DecodedSnapshot,
  decodeDatabaseState,
  encodeDatabaseState,
  type SnapshotRuntime,
} from "./serialization/index.ts";
export type { DatabaseState } from "./storage/database-state.ts";
export {
  type Affinity,
  affinityFromTypeName,
  applyAffinity,
  asSqlJsonText,
  asSqlReal,
  type BindValue,
  canonicalizeNumber,
  cloneSqlValue,
  coerceToNumber,
  compareSql,
  isSqlJsonText,
  isSqlReal,
  isTruthySql,
  type QueryRow,
  type QueryValue,
  SqlJsonText,
  SqlReal,
  type SqlValue,
  type StorageClass,
  sqlValueEquals,
  storageClassOf,
  toInteger,
  typeofSql,
  utf8Decode,
  utf8Encode,
} from "./types/value.ts";
