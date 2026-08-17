import { describe, expect, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";

describe("unsupported features", () => {
  test("CREATE VIRTUAL TABLE is explicitly unsupported", () => {
    const db = new InMemoryAdapter();
    const result = db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe("unsupported");
    expect(result.error?.message.toLowerCase()).toContain("unsupported");
    db.close();
  });

  test("CREATE TRIGGER is explicitly unsupported", () => {
    const db = new InMemoryAdapter();
    db.exec("CREATE TABLE t(id INTEGER)");
    const result = db.exec("CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END");
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe("unsupported");
    db.close();
  });

  test("ATTACH is explicitly unsupported", () => {
    const db = new InMemoryAdapter();
    const result = db.exec("ATTACH DATABASE 'other.db' AS other");
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe("unsupported");
    db.close();
  });

  test("RIGHT JOIN is explicitly unsupported", () => {
    const db = new InMemoryAdapter();
    db.exec("CREATE TABLE a(id INTEGER); CREATE TABLE b(id INTEGER)");
    const result = db.query("SELECT * FROM a RIGHT JOIN b ON a.id = b.id");
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe("unsupported");
    db.close();
  });
});
