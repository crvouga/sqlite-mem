import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareOrReport, compareStateOrReport, compareWriteOrReport, withDatabases } from "./helpers.ts";

const dmlArb = fc.oneof(
  fc.record({ kind: fc.constant("insert" as const), a: intArb, b: textArb }),
  fc.record({ kind: fc.constant("update" as const), a: intArb, b: textArb }),
  fc.record({ kind: fc.constant("delete" as const), a: intArb }),
  fc.record({ kind: fc.constant("select" as const) }),
);

const ciSteps = Number(process.env.SQLITE_MEM_STATEFUL_STEPS ?? "24");

describe("O3 stateful dump-after-each", () => {
  test("interleaved DML/SELECT match B + Dump after every step", () => {
    fc.assert(
      fc.property(fc.array(dmlArb, { minLength: 6, maxLength: ciSteps }), (ops) => {
        withDatabases((memory, sqlite) => {
          const ddl = "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)";
          compareOrReport("stateful-ddl", ddl, ops, memory.exec(ddl), sqlite.exec(ddl));
          compareStateOrReport("stateful-ddl-dump", ops, memory, sqlite);

          let nextId = 1;
          for (const op of ops) {
            if (op.kind === "insert") {
              const sql = "INSERT INTO t(id, a, b) VALUES (?, ?, ?)";
              const params = [nextId++, op.a, op.b];
              compareWriteOrReport("stateful-insert", sql, op, memory.exec(sql, params), sqlite.exec(sql, params));
            } else if (op.kind === "update") {
              const sql = "UPDATE t SET a = ?, b = ? WHERE id = (SELECT max(id) FROM t)";
              compareWriteOrReport(
                "stateful-update",
                sql,
                op,
                memory.exec(sql, [op.a, op.b]),
                sqlite.exec(sql, [op.a, op.b]),
              );
            } else if (op.kind === "delete") {
              const sql = "DELETE FROM t WHERE a = ?";
              compareWriteOrReport("stateful-delete", sql, op, memory.exec(sql, [op.a]), sqlite.exec(sql, [op.a]));
            } else {
              const sql = "SELECT id, a, b FROM t ORDER BY id";
              compareOrReport("stateful-select", sql, op, memory.query(sql), sqlite.query(sql));
            }
            compareStateOrReport("stateful-step-dump", op, memory, sqlite);
          }
        });
      }),
      fuzzAssertConfig(8),
    );
  });
});
