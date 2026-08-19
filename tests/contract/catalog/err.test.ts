import { expect } from "bun:test";
import { SqliteError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("ERR", [
  { id: "ERR-cat-01", kind: "error", sql: "SELCT 1", query: true },
  { id: "ERR-cat-02", kind: "error", sql: "SELECT * FROM nosuch", query: true },
  { id: "ERR-cat-03", kind: "error", setup: ["CREATE TABLE t(a INT)"], sql: "SELECT b FROM t", query: true },
  {
    id: "ERR-cat-04",
    kind: "error",
    setup: ["CREATE TABLE t(a INT UNIQUE)", "INSERT INTO t VALUES (1)"],
    sql: "INSERT INTO t VALUES (1)",
  },
  {
    id: "ERR-cat-05",
    kind: "divergence",
    fn: (db) => {
      try {
        db.query("SELECT ?", [Number.NaN]);
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).category).toBe("datatype_mismatch");
      }
    },
  },
  { id: "ERR-cat-06", kind: "error", sql: "SELECT FROM", query: true },
  {
    id: "ERR-time-01",
    kind: "divergence",
    fn: (db) => {
      try {
        db.prepare("SELCT 1");
        throw new Error("expected");
      } catch (error) {
        expect((error as SqliteError).category).toBe("syntax");
      }
    },
  },
  {
    id: "ERR-time-02",
    kind: "divergence",
    fn: (db) => {
      try {
        const stmt = db.prepare("SELECT * FROM nosuch");
        try {
          stmt.all();
        } catch {
          /* run-time no such table */
        }
      } catch (error) {
        expect((error as SqliteError).category).toBe("no_such_table");
      }
    },
  },
  {
    id: "ERR-time-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t(a INT UNIQUE)");
      db.exec("INSERT INTO t VALUES (1)");
      const stmt = db.prepare("INSERT INTO t VALUES (1)");
      try {
        stmt.run();
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
      }
    },
  },
  {
    id: "ERR-state-01",
    kind: "sequence",
    setup: ["CREATE TABLE t(a INT UNIQUE)", "INSERT INTO t VALUES (1)"],
    steps: [
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "INSERT INTO t VALUES (2)" },
      { sql: "SELECT a FROM t ORDER BY a", query: true },
    ],
  },
  {
    id: "ERR-inst-01",
    kind: "divergence",
    fn: (db) => {
      try {
        db.exec("SELECT * FROM nosuch");
        throw new Error("expected");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteError);
        expect((error as SqliteError).code).toBe((error as SqliteError).sqliteCode);
      }
    },
  },
]);
