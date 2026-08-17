import type { Statement } from "../ast/nodes.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { parseTokens } from "./parser.ts";

export { parseTokens } from "./parser.ts";

/** Tokenize `sql` and parse all statements (semicolon-separated). */
export function parse(sql: string): Statement[] {
  const tokens = tokenize(sql);
  return parseTokens(tokens);
}
