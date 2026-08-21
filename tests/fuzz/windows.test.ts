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
                db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [row.team, row.name, row.score]);
              }
            }

            const sql = [
              "SELECT team, name, score,",
              `row_number() OVER (PARTITION BY ${partitionCol} ORDER BY score, name) AS rn,`,
              "sum(score) OVER (PARTITION BY team ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running",
              "FROM scores",
              "ORDER BY team, score, name",
            ].join(" ");

            compareOrReport("windows", sql, { rows, partitionCol }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("random FILTER predicates and ROWS frames match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        intArb,
        fc.integer({ min: 0, max: 3 }),
        (rows, threshold, preceding) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE scores(id INTEGER PRIMARY KEY, team TEXT, name TEXT, score INTEGER)");
              rows.forEach((row, index) => {
                db.exec("INSERT INTO scores(id, team, name, score) VALUES (?, ?, ?, ?)", [
                  index + 1,
                  row.team,
                  row.name,
                  row.score,
                ]);
              });
            }

            const sql = [
              "SELECT id, team, score,",
              `sum(score) FILTER (WHERE score >= ${threshold}) OVER (`,
              `PARTITION BY team ORDER BY score, id ROWS BETWEEN ${preceding} PRECEDING AND CURRENT ROW`,
              ") AS filtered_running,",
              `count(*) FILTER (WHERE score < ${threshold}) OVER (PARTITION BY team) AS filtered_count`,
              "FROM scores ORDER BY id",
            ].join(" ");

            compareOrReport(
              "window-filter-frame",
              sql,
              { rows, threshold, preceding },
              memory.query(sql),
              sqlite.query(sql),
            );
          });
        },
      ),
      fuzzAssertConfig(30),
    );
  });

  test("RANGE frames and ntile match SQLite", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 8 }), (rows) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE scores(team TEXT, name TEXT, score INTEGER)");
            for (const row of rows) {
              db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [row.team, row.name, row.score]);
            }
          }

          const sql = [
            "SELECT team, name, score,",
            "ntile(2) OVER (PARTITION BY team ORDER BY score, name) AS bucket,",
            "sum(score) OVER (PARTITION BY team ORDER BY score RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS range_sum",
            "FROM scores ORDER BY team, score, name",
          ].join(" ");

          compareOrReport("window-range-ntile", sql, { rows }, memory.query(sql), sqlite.query(sql));
        });
      }),
      fuzzAssertConfig(25),
    );
  });

  test("GROUPS frames and EXCLUDE match SQLite", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        fc.constantFrom("CURRENT ROW", "GROUP", "TIES", "NO OTHERS"),
        (rows, exclude) => {
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE scores(team TEXT, name TEXT, score INTEGER)");
              for (const row of rows) {
                db.exec("INSERT INTO scores(team, name, score) VALUES (?, ?, ?)", [row.team, row.name, row.score]);
              }
            }
            const sql = [
              "SELECT team, name, score,",
              `sum(score) OVER (PARTITION BY team ORDER BY score, name GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE ${exclude}) AS gsum`,
              "FROM scores ORDER BY team, score, name",
            ].join(" ");
            compareOrReport("window-groups-exclude", sql, { rows, exclude }, memory.query(sql), sqlite.query(sql));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
