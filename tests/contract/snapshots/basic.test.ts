import { expect, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("SQL behavior matches before snapshot", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER,name TEXT)", "INSERT INTO t VALUES (1,'a'),(2,'b')"]);
  expectParity(memory.query("SELECT * FROM t ORDER BY id"), sqlite.query("SELECT * FROM t ORDER BY id"));
});

test("memory snapshot restores into a new adapter", () => {
  const source = new InMemoryAdapter();
  const restored = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,name TEXT)");
    source.exec("INSERT INTO t(name) VALUES ('a'),('b')");
    restored.restore(source.snapshot());
    expectParity(restored.query("SELECT * FROM t ORDER BY id"), source.query("SELECT * FROM t ORDER BY id"));
  } finally {
    source.close();
    restored.close();
  }
});

test("memory snapshot roundtrip discards later mutations", () => {
  const db = new InMemoryAdapter();
  try {
    db.exec("CREATE TABLE t(id INTEGER)");
    db.exec("INSERT INTO t VALUES (1),(2)");
    const bytes = db.snapshot();
    db.exec("INSERT INTO t VALUES (3)");
    db.restore(bytes);
    const result = db.query("SELECT id FROM t ORDER BY id");
    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  } finally {
    db.close();
  }
});

test("snapshot preserves schema constraints and defaults", () => {
  const source = new InMemoryAdapter();
  const restored = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,label TEXT NOT NULL DEFAULT 'x')");
    restored.restore(source.snapshot());
    expect(restored.exec("INSERT INTO t DEFAULT VALUES").ok).toBe(true);
    expect(restored.query("SELECT * FROM t").rows).toEqual([{ id: 1, label: "x" }]);
    expect(restored.exec("INSERT INTO t(label) VALUES (NULL)").error?.category).toBe("constraint_notnull");
  } finally {
    source.close();
    restored.close();
  }
});

test("snapshot clone stays in lockstep under identical ops", () => {
  const source = new InMemoryAdapter();
  const clone = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE, n INT DEFAULT 0)");
    source.exec("CREATE INDEX t_n ON t(n)");
    source.exec("CREATE VIEW v AS SELECT id, name FROM t WHERE n > 0");
    source.exec("INSERT INTO t(name, n) VALUES ('a', 1),('b', 0)");
    clone.restore(source.snapshot());

    const ops = [
      "INSERT INTO t(name, n) VALUES ('c', 2)",
      "UPDATE t SET n = n + 1 WHERE name = 'b'",
      "DELETE FROM t WHERE name = 'a'",
    ];
    for (const sql of ops) {
      expectParity(source.exec(sql), clone.exec(sql));
    }
    expectParity(
      source.query("SELECT id, name, n FROM t ORDER BY id"),
      clone.query("SELECT id, name, n FROM t ORDER BY id"),
    );
    expectParity(source.query("SELECT * FROM v ORDER BY id"), clone.query("SELECT * FROM v ORDER BY id"));
    expectParity(
      source.query("SELECT name FROM sqlite_master WHERE type IN ('index','view') ORDER BY name"),
      clone.query("SELECT name FROM sqlite_master WHERE type IN ('index','view') ORDER BY name"),
    );
  } finally {
    source.close();
    clone.close();
  }
});

test("snapshot preserves rowids across restore and further inserts", () => {
  const source = new InMemoryAdapter();
  const clone = new InMemoryAdapter();
  try {
    source.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
    source.exec("INSERT INTO t(id, name) VALUES (10, 'x')");
    source.exec("INSERT INTO t(name) VALUES ('y')");
    clone.restore(source.snapshot());
    expectParity(source.query("SELECT id, name FROM t ORDER BY id"), clone.query("SELECT id, name FROM t ORDER BY id"));
    expectParity(source.exec("INSERT INTO t(name) VALUES ('z')"), clone.exec("INSERT INTO t(name) VALUES ('z')"));
    expectParity(source.query("SELECT id, name FROM t ORDER BY id"), clone.query("SELECT id, name FROM t ORDER BY id"));
  } finally {
    source.close();
    clone.close();
  }
});
