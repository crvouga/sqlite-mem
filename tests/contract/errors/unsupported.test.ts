import { describe, expect, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";

function expectUnsupported(sql: string, setup: string[] = []): void {
  const db = new InMemoryAdapter();
  for (const statement of setup) {
    expect(db.exec(statement).ok, statement).toBe(true);
  }
  const result = sql.trimStart().toUpperCase().startsWith("SELECT") ||
      sql.trimStart().toUpperCase().startsWith("WITH")
    ? db.query(sql)
    : db.exec(sql);
  expect(result.ok, `${sql} → ${result.error?.message}`).toBe(false);
  expect(result.error?.category).toBe("unsupported");
  db.close();
}

describe("unsupported features", () => {
  test("CREATE VIRTUAL TABLE is explicitly unsupported", () => {
    expectUnsupported("CREATE VIRTUAL TABLE t USING fts5(content)");
  });

  test("CREATE TRIGGER is explicitly unsupported", () => {
    expectUnsupported("CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END", [
      "CREATE TABLE t(id INTEGER)",
    ]);
  });

  test("DROP TRIGGER is explicitly unsupported", () => {
    expectUnsupported("DROP TRIGGER trg");
  });

  test("ATTACH is explicitly unsupported", () => {
    expectUnsupported("ATTACH DATABASE 'other.db' AS other");
  });

  test("DETACH is explicitly unsupported", () => {
    expectUnsupported("DETACH DATABASE other");
  });

  test("RIGHT JOIN is explicitly unsupported", () => {
    expectUnsupported("SELECT * FROM a RIGHT JOIN b ON a.id = b.id", [
      "CREATE TABLE a(id INTEGER)",
      "CREATE TABLE b(id INTEGER)",
    ]);
  });

  test("FULL JOIN is explicitly unsupported", () => {
    expectUnsupported("SELECT * FROM a FULL JOIN b ON a.id = b.id", [
      "CREATE TABLE a(id INTEGER)",
      "CREATE TABLE b(id INTEGER)",
    ]);
  });

  test("UPDATE FROM is explicitly unsupported", () => {
    expectUnsupported("UPDATE a SET id = b.id FROM b WHERE a.id = b.id", [
      "CREATE TABLE a(id INTEGER)",
      "CREATE TABLE b(id INTEGER)",
    ]);
  });

  test("GENERATED ALWAYS AS columns are explicitly unsupported", () => {
    expectUnsupported("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id+1) STORED)");
  });

  test("WITHOUT ROWID is explicitly unsupported", () => {
    expectUnsupported("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT) WITHOUT ROWID");
  });

  test("INDEXED BY is explicitly unsupported", () => {
    expectUnsupported("SELECT * FROM t INDEXED BY idx", [
      "CREATE TABLE t(id INTEGER)",
      "CREATE INDEX idx ON t(id)",
    ]);
  });

  test("NOT INDEXED is explicitly unsupported", () => {
    expectUnsupported("SELECT * FROM t NOT INDEXED", [
      "CREATE TABLE t(id INTEGER)",
    ]);
  });

  test("MATCH operator is explicitly unsupported", () => {
    expectUnsupported("SELECT * FROM t WHERE content MATCH 'hello'", [
      "CREATE TABLE t(content TEXT)",
      "INSERT INTO t VALUES ('x')",
    ]);
  });

  test("table-valued functions are explicitly unsupported", () => {
    expectUnsupported("SELECT * FROM generate_series(1, 3)");
  });
});
