import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, nullArb, textArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

const candidateArb = fc.record({
  a: intArb,
  b: fc.oneof(nullArb, textArb),
});

describe("constraint differential fuzz", () => {
  test("UNIQUE and CHECK inserts agree on acceptance and error category", () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { minLength: 1, maxLength: 12 }), (candidates) => {
        withDatabases((memory, sqlite) => {
          const create = [
            "CREATE TABLE t(",
            "id INTEGER PRIMARY KEY,",
            "a INT CHECK(a >= -10 AND a <= 10),",
            "b TEXT UNIQUE)",
          ].join(" ");
          memory.exec(create);
          sqlite.exec(create);

          candidates.forEach((candidate, index) => {
            const sql = "INSERT INTO t(id, a, b) VALUES (?, ?, ?)";
            // Avoid candidates that violate CHECK and UNIQUE simultaneously:
            // SQLite does not promise which constraint error is reported first.
            const b =
              candidate.a >= -10 && candidate.a <= 10
                ? candidate.b
                : `check-failure-${index}`;
            const params = [index + 1, candidate.a, b] as const;
            compareOutcomeOrReport(
              "constraints-insert",
              sql,
              { candidates, index },
              memory.exec(sql, [...params]),
              sqlite.exec(sql, [...params]),
            );
          });

          const select = "SELECT id, a, b FROM t ORDER BY id";
          compareOrReport(
            "constraints-final",
            select,
            candidates,
            memory.query(select),
            sqlite.query(select),
          );
        });
      }),
      fuzzAssertConfig(35),
    );
  });
});
