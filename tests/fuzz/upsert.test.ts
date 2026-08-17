import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, withDatabases } from "./helpers.ts";

const upsertArb = fc.record({
  key: fc.integer({ min: 1, max: 6 }),
  value: intArb,
  action: fc.constantFrom("nothing", "replace", "add"),
});

describe("upsert differential fuzz", () => {
  test("random conflict actions match SQLite", () => {
    fc.assert(
      fc.property(fc.array(upsertArb, { minLength: 1, maxLength: 12 }), (upserts) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE counters(key INTEGER PRIMARY KEY, value INT)");
          }

          for (const upsert of upserts) {
            const action =
              upsert.action === "nothing"
                ? "DO NOTHING"
                : upsert.action === "replace"
                  ? "DO UPDATE SET value = excluded.value"
                  : "DO UPDATE SET value = counters.value + excluded.value";
            const sql = `INSERT INTO counters(key, value) VALUES (?, ?) ON CONFLICT(key) ${action}`;
            compareOrReport(
              `upsert-${upsert.action}`,
              sql,
              { upserts, upsert },
              memory.exec(sql, [upsert.key, upsert.value]),
              sqlite.exec(sql, [upsert.key, upsert.value]),
            );
          }

          const select = "SELECT key, value FROM counters ORDER BY key";
          compareOrReport("upsert-final", select, upserts, memory.query(select), sqlite.query(select));
        });
      }),
      fuzzAssertConfig(35),
    );
  });
});
