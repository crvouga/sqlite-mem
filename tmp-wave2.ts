import { Database as Real } from "bun:sqlite";
import { Database as Mem } from "./src/index.ts";

function cmp(label: string, setup: string[], sql: string) {
  const r = new Real(":memory:");
  const m = new Mem();
  for (const s of setup) {
    r.exec(s);
    m.exec(s);
  }
  let real: unknown;
  let mem: unknown;
  try {
    real = r.query(sql).all();
  } catch (e) {
    real = `ERR:${(e as Error).message}`;
  }
  try {
    mem = m.query(sql);
  } catch (e) {
    mem = `ERR:${(e as { category: string }).category}:${(e as Error).message}`;
  }
  const same = JSON.stringify(real) === JSON.stringify(mem);
  console.log(same ? "OK" : "DIFF", label);
  if (!same) console.log("  real", real, "\n  mem", mem);
}

cmp("subsec", [], "SELECT datetime('2024-01-01 12:00:00.123','subsec') AS v");
cmp("auto", [], "SELECT datetime('2024-01-01 12:00:00','auto') AS v");
cmp("ceiling", [], "SELECT datetime('2024-01-01 12:00:00.1','ceiling') AS v");
cmp("floor", [], "SELECT datetime('2024-01-01 12:00:00.9','floor') AS v");
cmp(
  "nth_value",
  ["CREATE TABLE t(id INT,v INT)", "INSERT INTO t VALUES (1,10),(2,20),(3,30)"],
  "SELECT id, nth_value(v,2) OVER (ORDER BY id) AS n FROM t ORDER BY id",
);
cmp(
  "window where",
  ["CREATE TABLE t(id INT)", "INSERT INTO t VALUES (1)"],
  "SELECT id FROM t WHERE row_number() OVER (ORDER BY id) = 1",
);
cmp(
  "upsert OR IGNORE",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES (1,'a')"],
  "SELECT changes()",
);
cmp(
  "json_group FILTER",
  ["CREATE TABLE t(id INT, v TEXT)", "INSERT INTO t VALUES (1,'a'),(2,NULL),(3,'b')"],
  "SELECT json_group_array(v) FILTER (WHERE v IS NOT NULL) AS j FROM t",
);
cmp("json_each null", [], "SELECT count(*) AS n FROM json_each(NULL)");
cmp(
  "UNIQUE COLLATE",
  ["CREATE TABLE t(v TEXT UNIQUE COLLATE NOCASE)", "INSERT INTO t VALUES ('A')"],
  "SELECT v FROM t",
);
cmp(
  "LIKE BINARY col",
  ["CREATE TABLE t(v TEXT COLLATE BINARY)", "INSERT INTO t VALUES ('Abc')"],
  "SELECT v FROM t WHERE v LIKE 'a%'",
);
cmp(
  "UPDATE FROM multi",
  [
    "CREATE TABLE a(id INT, v TEXT)",
    "CREATE TABLE b(id INT, v TEXT)",
    "INSERT INTO a VALUES (1,'x')",
    "INSERT INTO b VALUES (1,'y'),(1,'z')",
  ],
  "SELECT 1",
);
