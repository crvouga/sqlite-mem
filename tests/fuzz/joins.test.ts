import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, textArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const rowsArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 8 }),
    value: textArb,
  }),
  { selector: (row) => row.id, minLength: 0, maxLength: 5 },
);

describe("join differential fuzz", () => {
  test("random inner and left joins match SQLite", () => {
    fc.assert(
      fc.property(
        rowsArb,
        rowsArb,
        fc.constantFrom("INNER", "LEFT"),
        fc.constantFrom("=", "<", "<=", ">", ">="),
        (leftRows, rightRows, joinType, predicate) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE l(id INTEGER PRIMARY KEY, value TEXT)");
              db.exec("CREATE TABLE r(id INTEGER PRIMARY KEY, value TEXT)");
              for (const row of leftRows) db.exec("INSERT INTO l VALUES (?, ?)", [row.id, row.value]);
              for (const row of rightRows) db.exec("INSERT INTO r VALUES (?, ?)", [row.id, row.value]);
            }

            const sql = [
              "SELECT l.id AS lid, l.value AS lv, r.id AS rid, r.value AS rv",
              `FROM l ${joinType} JOIN r ON l.id ${predicate} r.id`,
              "ORDER BY l.id, r.id",
            ].join(" ");
            compareOrReport(
              "join",
              sql,
              { leftRows, rightRows, joinType, predicate },
              memory.query(sql),
              sqlite.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });
});
