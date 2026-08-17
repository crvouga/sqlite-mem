import { describe, expect, test } from "bun:test";
import { Database, DEFAULT_NOW, Prng } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";

describe("determinism", () => {
  test("identical seeds produce identical random() streams", () => {
    const a = new Database({ seed: 42 });
    const b = new Database({ seed: 42 });
    const left = a.query<{ v: bigint | number }>("SELECT random() AS v UNION ALL SELECT random() AS v UNION ALL SELECT random() AS v");
    const right = b.query<{ v: bigint | number }>("SELECT random() AS v UNION ALL SELECT random() AS v UNION ALL SELECT random() AS v");
    expect(left.map((row) => String(row.v))).toEqual(right.map((row) => String(row.v)));
  });

  test("different seeds diverge", () => {
    const a = new Database({ seed: 1 });
    const b = new Database({ seed: 2 });
    const left = a.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v;
    const right = b.query<{ v: bigint | number }>("SELECT random() AS v")[0]!.v;
    expect(String(left)).not.toEqual(String(right));
  });

  test("date('now') is fixed by default", () => {
    const db = new Database();
    const row = db.query<{ d: string }>("SELECT date('now') AS d")[0]!;
    expect(row.d).toBe("2000-01-01");
    expect(DEFAULT_NOW.toISOString()).toBe("2000-01-01T00:00:00.000Z");
  });

  test("injectable clock overrides now", () => {
    const db = new Database({ now: new Date("2012-06-15T12:34:56.000Z") });
    expect(db.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2012-06-15");
    expect(db.query<{ t: string }>("SELECT time('now') AS t")[0]!.t).toBe("12:34:56");
  });

  test("snapshots are byte-identical for equivalent logical state", () => {
    const setup = (db: Database) => {
      db.exec("CREATE TABLE z(id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("INSERT INTO z(name) VALUES ('z')");
      db.exec("INSERT INTO a(name) VALUES ('a')");
      db.exec("CREATE INDEX idx_z ON z(name)");
      db.exec("CREATE INDEX idx_a ON a(name)");
    };
    const left = new Database({ seed: 7 });
    const right = new Database({ seed: 7 });
    setup(left);
    setup(right);
    expect([...left.snapshot()]).toEqual([...right.snapshot()]);
  });

  test("Prng is deterministic across clones of state", () => {
    const p = new Prng(99);
    const values = [p.nextSqliteRandom(), p.nextSqliteRandom(), p.nextSqliteRandom()].map(String);
    const q = new Prng(99);
    expect([q.nextSqliteRandom(), q.nextSqliteRandom(), q.nextSqliteRandom()].map(String)).toEqual(values);
  });

  test("bound -0 becomes +0", () => {
    const db = new InMemoryAdapter();
    db.exec("CREATE TABLE t(x REAL)");
    db.exec("INSERT INTO t(x) VALUES (?)", [-0]);
    const result = db.query("SELECT x, typeof(x) AS t FROM t");
    expect(result.ok).toBe(true);
    expect(Object.is(result.rows[0]!.x, -0)).toBe(false);
    expect(result.rows[0]!.x).toBe(0);
    db.close();
  });
});
