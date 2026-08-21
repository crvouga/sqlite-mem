import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

describe("generated column differential fuzz", () => {
  test("STORED and VIRTUAL generated columns match SQLite", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("STORED", "VIRTUAL"),
        fc.array(intArb, { minLength: 1, maxLength: 6 }),
        intArb,
        (kind, values, delta) => {
          withDatabases((memory, sqlite) => {
            const ddl = `CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, g INT GENERATED ALWAYS AS (a + 1) ${kind})`;
            for (const db of [memory, sqlite]) {
              db.exec(ddl);
              for (const [i, a] of values.entries()) {
                db.exec("INSERT INTO t(id, a) VALUES (?, ?)", [i + 1, a]);
              }
            }
            const select = "SELECT id, a, g FROM t ORDER BY id";
            compareOrReport("gen-select", select, { kind, values }, memory.query(select), sqlite.query(select));

            const upd = `UPDATE t SET a = a + ${delta}`;
            compareOutcomeOrReport("gen-update", upd, { kind, delta }, memory.exec(upd), sqlite.exec(upd));
            compareOrReport(
              "gen-after-update",
              select,
              { kind, values, delta },
              memory.query(select),
              sqlite.query(select),
            );

            const bad = "INSERT INTO t(id, a, g) VALUES (99, 1, 2)";
            compareOutcomeOrReport("gen-insert-gen", bad, { kind }, memory.exec(bad), sqlite.exec(bad));
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
