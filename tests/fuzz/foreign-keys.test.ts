import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig } from "./config.ts";
import { compareOrReport, compareOutcomeOrReport, withDatabases } from "./helpers.ts";

const opArb = fc.record({
  kind: fc.constantFrom("insert_parent", "insert_child", "delete_parent", "delete_child"),
  id: fc.integer({ min: 1, max: 8 }),
  parentId: fc.integer({ min: 1, max: 8 }),
});

describe("foreign key differential fuzz", () => {
  test("random FK insert and delete outcomes match SQLite", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 4, maxLength: 14 }), (operations) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("PRAGMA foreign_keys=ON");
            db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
            db.exec(
              "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)",
            );
          }

          for (const [index, op] of operations.entries()) {
            const sql =
              op.kind === "insert_parent"
                ? `INSERT INTO parent(id) VALUES (${op.id})`
                : op.kind === "insert_child"
                  ? `INSERT INTO child(id, parent_id) VALUES (${op.id}, ${op.parentId})`
                  : op.kind === "delete_parent"
                    ? `DELETE FROM parent WHERE id = ${op.id}`
                    : `DELETE FROM child WHERE id = ${op.id}`;
            compareOutcomeOrReport(
              `fk-${op.kind}`,
              sql,
              { operations, index },
              memory.exec(sql),
              sqlite.exec(sql),
            );
          }

          const parents = "SELECT id FROM parent ORDER BY id";
          const children = "SELECT id, parent_id FROM child ORDER BY id";
          compareOrReport("fk-parents", parents, operations, memory.query(parents), sqlite.query(parents));
          compareOrReport("fk-children", children, operations, memory.query(children), sqlite.query(children));
        });
      }),
      fuzzAssertConfig(30),
    );
  });
});
