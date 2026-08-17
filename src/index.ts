export { Database, type DatabaseOptions } from "./api/database.ts";
export { Statement } from "./api/statement.ts";
export { SqliteError } from "./errors/index.ts";
export type { ResultSet } from "./executor/result.ts";
export { evalExpr } from "./expressions/eval.ts";
export { globMatch, likeMatch } from "./expressions/like.ts";
export { tokenize } from "./lexer/tokenize.ts";
export { parse } from "./parser/index.ts";
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
export {
  type Affinity,
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
  type SqlValue,
  type StorageClass,
  sqlValueEquals,
  storageClassOf,
  toInteger,
  typeofSql,
  utf8Decode,
  utf8Encode,
} from "./types/value.ts";
