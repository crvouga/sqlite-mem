import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb, realArb, valueArb } from "./config.ts";
import { compareOrReport, sqlLiteral, withDatabases } from "./helpers.ts";

const numericArb = fc.oneof(nullArb, intArb, realArb);
const expressionArb = fc.oneof(
  fc.record({
    a: numericArb,
    b: numericArb,
    op: fc.constantFrom("+", "-", "*", "%", "&", "|"),
  }),
  fc.record({
    a: valueArb,
    b: valueArb,
    op: fc.constantFrom("=", "!=", "<", "<=", ">", ">="),
  }),
);

describe("expression differential fuzz", () => {
  test("random binary expressions match SQLite", () => {
    fc.assert(
      fc.property(expressionArb, ({ a, b, op }) => {
        const sql = `SELECT (${sqlLiteral(a)} ${op} ${sqlLiteral(b)}) AS v`;
        withDatabases((memory, sqlite) => {
          compareOrReport("expression", sql, { a, b, op }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(40),
    );
  });
});
