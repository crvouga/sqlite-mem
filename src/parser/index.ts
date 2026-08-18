import type { Statement as ParsedStatement } from "../ast/nodes.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { parseTokens } from "./parser.ts";

/** Parsed SQL statement AST (`SELECT`, `INSERT`, `CREATE TABLE`, …). */
export type { Statement as ParsedStatement } from "../ast/nodes.ts";
export { parseTokens } from "./parser.ts";

/**
 * Tokenize `sql` and parse every semicolon-separated statement.
 *
 * @param sql - SQLite SQL text.
 * @returns AST statements in source order.
 */
export function parse(sql: string): ParsedStatement[] {
  const tokens = tokenize(sql);
  return parseTokens(tokens);
}
