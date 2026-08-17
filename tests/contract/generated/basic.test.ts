import { describe, expect, test } from "bun:test";
import { Database, SqliteError } from "../../../src/index.ts";
import { parity } from "../helpers.ts";

parity(
  "STORED generated column is materialized",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id + 1) STORED)",
    "INSERT INTO t(id) VALUES (1),(2)",
  ],
  "SELECT id, v FROM t ORDER BY id",
);

parity(
  "VIRTUAL generated column is computed on read",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id * 2) VIRTUAL)",
    "INSERT INTO t(id) VALUES (3),(4)",
  ],
  "SELECT id, v FROM t ORDER BY id",
);

describe("generated column errors", () => {
  test("cannot insert into generated column", () => {
    const db = new Database();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id+1) STORED)");
    expect(() => db.exec("INSERT INTO t(id, v) VALUES (1, 99)")).toThrow(SqliteError);
  });
});
