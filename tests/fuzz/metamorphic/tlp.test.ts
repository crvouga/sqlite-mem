import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "../config.ts";
import { compareOrReport, withDatabases } from "../helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 40 }),
  a: intArb,
  b: textArb.filter((s) => s.length <= 12),
});

const predicateArb = fc.oneof(
  fc.record({ kind: fc.constant("gt" as const), n: intArb }),
  fc.record({ kind: fc.constant("eq" as const), n: intArb }),
  fc.record({ kind: fc.constant("isnull" as const) }),
  fc.record({ kind: fc.constant("like" as const), p: fc.constantFrom("%", "a%", "%z", "_") }),
);

function predicateSql(p: fc.InferValue<typeof predicateArb>): string {
  if (p.kind === "gt") return `a > ${p.n}`;
  if (p.kind === "eq") return `a = ${p.n}`;
  if (p.kind === "isnull") return "a IS NULL";
  return `b LIKE '${p.p.replaceAll("'", "''")}'`;
}

/**
 * Ternary Logic Partitioning (SQLancer-style):
 * |Q| = |Q WHERE P| + |Q WHERE NOT P| + |Q WHERE P IS NULL|
 */
describe("TLP metamorphic fuzz", () => {
  test("partition counts sum to full query on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 20 }),
        predicateArb,
        (rows, pred) => {
          const p = predicateSql(pred);
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              }
            }

            const full = "SELECT id, a, b FROM t ORDER BY id";
            const partTrue = `SELECT id, a, b FROM t WHERE (${p}) ORDER BY id`;
            const partFalse = `SELECT id, a, b FROM t WHERE NOT (${p}) ORDER BY id`;
            const partNull = `SELECT id, a, b FROM t WHERE (${p}) IS NULL ORDER BY id`;

            for (const [label, sql] of [
              ["full", full],
              ["true", partTrue],
              ["false", partFalse],
              ["null", partNull],
            ] as const) {
              compareOrReport(`tlp-${label}`, sql, { rows, pred }, memory.query(sql), sqlite.query(sql));
            }

            for (const db of [memory, sqlite]) {
              const nFull = db.query(full).rows.length;
              const nTrue = db.query(partTrue).rows.length;
              const nFalse = db.query(partFalse).rows.length;
              const nNull = db.query(partNull).rows.length;
              if (nFull !== nTrue + nFalse + nNull) {
                throw new Error(
                  `TLP cardinality broken: ${nFull} !== ${nTrue}+${nFalse}+${nNull} pred=${p} engine=${db === memory ? "mem" : "sqlite"}`,
                );
              }
            }
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
