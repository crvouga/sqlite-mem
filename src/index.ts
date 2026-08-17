export { Database, type DatabaseOptions } from "./api/database.ts";
export { Statement } from "./api/statement.ts";
export { parse } from "./parser/index.ts";
export { tokenize } from "./lexer/tokenize.ts";
export { SqliteError } from "./errors/index.ts";
export {
  decodeDatabaseState,
  encodeDatabaseState,
  type DecodedSnapshot,
  type SnapshotRuntime,
} from "./serialization/index.ts";
export { evalExpr } from "./expressions/eval.ts";
export { likeMatch, globMatch } from "./expressions/like.ts";
export {
  affinityFromTypeName,
  applyAffinity,
  asSqlReal,
  canonicalizeNumber,
  cloneSqlValue,
  coerceToNumber,
  compareSql,
  isSqlReal,
  isTruthySql,
  SqlReal,
  sqlValueEquals,
  storageClassOf,
  toInteger,
  typeofSql,
  utf8Decode,
  utf8Encode,
  type Affinity,
  type SqlValue,
  type StorageClass,
} from "./types/value.ts";
export {
  DEFAULT_DATABASE_SEED,
  DEFAULT_NOW,
  Prng,
  deriveSeed,
  fixedClock,
  resolveClock,
  type Clock,
} from "./runtime/index.ts";
export type { ResultSet } from "./executor/result.ts";
