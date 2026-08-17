import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const rowArb = fc.record({
  team: fc.constantFrom("a", "b", "c"),
  name: textArb.filter((s) => s.length > 0),
  score: intArb,
});

describe("window differential fuzz", () => {
  test("random row_number and sum windows match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        fc.constantFrom("team", "score"),
        (rows, partitionCol) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE scores(team TEXT, name TEXT, score INTEGER)");
              for (const row of rows) {
                db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [
                  row.team,
                  row.name,
                  row.score,
                ]);
              }
            }

            const sql = [
              "SELECT team, name, score,",
              `row_number() OVER (PARTITION BY ${partitionCol} ORDER BY score, name) AS rn,`,
              "sum(score) OVER (PARTITION BY team ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running",
              "FROM scores",
              "ORDER BY team, score, name",
            ].join(" ");

            compareOrReport(
              "windows",
              sql,
              { rows, partitionCol },
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
