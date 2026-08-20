import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database } from "../../src/index.ts";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import {
  compareOrReport,
  compareOutcomeOrReport,
  compareStateOrReport,
  compareWriteOrReport,
  withDatabases,
} from "./helpers.ts";

type MixedOp =
  | { kind: "insert"; a: number; b: string }
  | { kind: "update"; a: number; b: string }
  | { kind: "delete"; a: number }
  | { kind: "select" }
  | { kind: "begin" }
  | { kind: "commit" }
  | { kind: "rollback" }
  | { kind: "savepoint" }
  | { kind: "release" }
  | { kind: "rollback_to" }
  | { kind: "add_index" }
  | { kind: "drop_index" }
  | { kind: "pragma_fk" }
  | { kind: "alter_add" }
  | { kind: "create_view" }
  | { kind: "drop_view" };

const mixedOpArb: fc.Arbitrary<MixedOp> = fc.oneof(
  fc.record({ kind: fc.constant("insert" as const), a: intArb, b: textArb }),
  fc.record({ kind: fc.constant("update" as const), a: intArb, b: textArb }),
  fc.record({ kind: fc.constant("delete" as const), a: intArb }),
  fc.record({ kind: fc.constant("select" as const) }),
  fc.record({ kind: fc.constant("begin" as const) }),
  fc.record({ kind: fc.constant("commit" as const) }),
  fc.record({ kind: fc.constant("rollback" as const) }),
  fc.record({ kind: fc.constant("savepoint" as const) }),
  fc.record({ kind: fc.constant("release" as const) }),
  fc.record({ kind: fc.constant("rollback_to" as const) }),
  fc.record({ kind: fc.constant("add_index" as const) }),
  fc.record({ kind: fc.constant("drop_index" as const) }),
  fc.record({ kind: fc.constant("pragma_fk" as const) }),
  fc.record({ kind: fc.constant("alter_add" as const) }),
  fc.record({ kind: fc.constant("create_view" as const) }),
  fc.record({ kind: fc.constant("drop_view" as const) }),
);

const ciSteps = Number(process.env.SQLITE_MEM_MIXED_STEPS ?? "20");

const DDL_KINDS = new Set([
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "rollback_to",
  "add_index",
  "drop_index",
  "pragma_fk",
  "alter_add",
  "create_view",
  "drop_view",
]);

describe("mixed DDL/DML/txn/PRAGMA stateful simulation", () => {
  test("interleaved ops match B-tuple + Dump after every step", () => {
    fc.assert(
      fc.property(fc.array(mixedOpArb, { minLength: 8, maxLength: ciSteps }), (ops) => {
        withDatabases((memory, sqlite) => {
          const ddl = "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)";
          compareOutcomeOrReport("mixed-ddl", ddl, ops, memory.exec(ddl), sqlite.exec(ddl));
          compareStateOrReport("mixed-ddl-dump", ops, memory, sqlite);

          let nextId = 1;
          let inTxn = false;
          let savepointDepth = 0;
          let hasIndex = false;
          let hasNote = false;
          let hasView = false;

          for (const [index, op] of ops.entries()) {
            let sql: string | null = null;
            let isQuery = false;

            if (op.kind === "insert") {
              sql = `INSERT INTO t(id, a, b) VALUES (${nextId++}, ${op.a}, '${op.b.replaceAll("'", "''")}')`;
            } else if (op.kind === "update") {
              sql = `UPDATE t SET a = ${op.a}, b = '${op.b.replaceAll("'", "''")}' WHERE id = (SELECT max(id) FROM t)`;
            } else if (op.kind === "delete") {
              sql = `DELETE FROM t WHERE a = ${op.a}`;
            } else if (op.kind === "select") {
              sql = "SELECT id, a, b FROM t ORDER BY id";
              isQuery = true;
            } else if (op.kind === "begin") {
              if (inTxn) continue;
              sql = "BEGIN";
              inTxn = true;
            } else if (op.kind === "commit") {
              if (!inTxn) continue;
              sql = "COMMIT";
              inTxn = false;
              savepointDepth = 0;
            } else if (op.kind === "rollback") {
              if (!inTxn) continue;
              sql = "ROLLBACK";
              inTxn = false;
              savepointDepth = 0;
            } else if (op.kind === "savepoint") {
              if (!inTxn) {
                compareOutcomeOrReport(`mixed-begin-${index}`, "BEGIN", op, memory.exec("BEGIN"), sqlite.exec("BEGIN"));
                inTxn = true;
              }
              savepointDepth++;
              sql = `SAVEPOINT sp${savepointDepth}`;
            } else if (op.kind === "release") {
              if (savepointDepth === 0) continue;
              sql = `RELEASE sp${savepointDepth}`;
              savepointDepth--;
            } else if (op.kind === "rollback_to") {
              if (savepointDepth === 0) continue;
              sql = `ROLLBACK TO sp${savepointDepth}`;
            } else if (op.kind === "add_index") {
              if (hasIndex || inTxn) continue;
              sql = "CREATE INDEX IF NOT EXISTS t_a ON t(a)";
              hasIndex = true;
            } else if (op.kind === "drop_index") {
              if (!hasIndex || inTxn) continue;
              sql = "DROP INDEX IF EXISTS t_a";
              hasIndex = false;
            } else if (op.kind === "pragma_fk") {
              sql = "PRAGMA foreign_keys = ON";
            } else if (op.kind === "alter_add") {
              if (hasNote || inTxn) continue;
              sql = "ALTER TABLE t ADD COLUMN note TEXT DEFAULT ''";
              hasNote = true;
            } else if (op.kind === "create_view") {
              if (hasView || inTxn) continue;
              sql = "CREATE VIEW IF NOT EXISTS t_view AS SELECT id, a FROM t";
              hasView = true;
            } else if (op.kind === "drop_view") {
              if (!hasView || inTxn) continue;
              sql = "DROP VIEW IF EXISTS t_view";
              hasView = false;
            }

            if (sql === null) continue;

            if (isQuery) {
              compareOrReport(`mixed-${op.kind}-${index}`, sql, op, memory.query(sql), sqlite.query(sql));
            } else if (DDL_KINDS.has(op.kind)) {
              compareOutcomeOrReport(`mixed-${op.kind}-${index}`, sql, op, memory.exec(sql), sqlite.exec(sql));
            } else {
              compareWriteOrReport(`mixed-${op.kind}-${index}`, sql, op, memory.exec(sql), sqlite.exec(sql));
            }
            compareStateOrReport(`mixed-dump-${index}`, { op, index }, memory, sqlite);
          }

          if (inTxn) {
            compareOutcomeOrReport("mixed-final-commit", "COMMIT", ops, memory.exec("COMMIT"), sqlite.exec("COMMIT"));
            compareStateOrReport("mixed-final-dump", ops, memory, sqlite);
          }
        });
      }),
      fuzzAssertConfig(10),
    );
  });
});

describe("snapshot mid-sequence property", () => {
  test("SQLM snapshot/restore preserves ordinary table state", () => {
    const db = new Database({ seed: 42 });
    try {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
      db.exec("INSERT INTO t VALUES (1, 10, 'x'), (2, 20, 'y')");
      db.exec("BEGIN");
      db.exec("INSERT INTO t VALUES (3, 30, 'z')");
      db.exec("SAVEPOINT sp1");
      db.exec("UPDATE t SET a = 99 WHERE id = 1");
      db.exec("RELEASE sp1");
      db.exec("COMMIT");
      db.exec("CREATE INDEX t_a ON t(a)");
      db.exec("PRAGMA foreign_keys = ON");

      const before = db.query("SELECT id, a, b FROM t ORDER BY id");
      const snap = db.snapshot();
      db.exec("DELETE FROM t");
      expect(db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
      db.restore(snap);
      expect(db.query("SELECT id, a, b FROM t ORDER BY id")).toEqual(before);
    } finally {
      db.close();
    }
  });
});
