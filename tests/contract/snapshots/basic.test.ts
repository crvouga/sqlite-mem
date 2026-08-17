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
