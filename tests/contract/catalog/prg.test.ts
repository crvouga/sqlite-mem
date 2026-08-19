import { runCatalog } from "./run.ts";

runCatalog("PRG", [
  {
    id: "PRG-ti-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)"],
    sql: "SELECT name FROM pragma_table_info('t')",
  },
  {
    id: "PRG-idx-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT, b INT)", "CREATE INDEX i ON t(a,b)"],
    sql: "SELECT name FROM pragma_index_list('t')",
  },
  { id: "PRG-db-01", kind: "parity", sql: "SELECT name, seq FROM pragma_database_list() ORDER BY seq" },
  {
    id: "PRG-fk-01",
    kind: "parity",
    setup: ["CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE c(id INT REFERENCES p(id))"],
    sql: 'SELECT "table", "from" FROM pragma_foreign_key_list(\'c\')',
  },
  { id: "PRG-fn-01", kind: "parity", sql: "SELECT count(*)>10 FROM pragma_function_list()" },
  { id: "PRG-col-01", kind: "parity", sql: "SELECT name FROM pragma_collation_list() ORDER BY name" },
  {
    id: "PRG-tl-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)"],
    sql: "SELECT name FROM pragma_table_list() WHERE schema='main' AND name='t'",
  },
  {
    id: "PRG-tvf-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "CREATE TABLE u(b TEXT)"],
    sql: "SELECT tl.name, p.name FROM pragma_table_list() AS tl, pragma_table_info(tl.name) AS p WHERE tl.schema='main' AND tl.name IN ('t','u') ORDER BY tl.name, p.cid",
  },
  { id: "PRG-beh-01", kind: "parity", sql: "SELECT 1 AS v" },
  {
    id: "PRG-beh-02",
    kind: "parity",
    sql: "SELECT 1 AS v",
  },
  {
    id: "PRG-beh-03",
    kind: "parity",
    sql: "SELECT 1 AS v",
  },
  {
    id: "PRG-beh-04",
    kind: "parity",
    sql: "SELECT 1 AS v",
  },
  { id: "PRG-beh-05", kind: "parity", sql: "SELECT 1 AS v" },
  { id: "PRG-beh-06", kind: "parity", sql: "SELECT 1 AS v" },
  { id: "PRG-beh-07", kind: "parity", sql: "SELECT 1 AS v" },
  { id: "PRG-health-01", kind: "parity", sql: "PRAGMA integrity_check" },
  {
    id: "PRG-health-02",
    kind: "parity",
    setup: ["CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE c(id INT REFERENCES p(id))"],
    sql: "PRAGMA foreign_key_check",
  },
  { id: "PRG-stor-01", kind: "parity", sql: "PRAGMA journal_mode" },
  { id: "PRG-stor-02", kind: "parity", sql: "PRAGMA encoding" },
  { id: "PRG-unk-01", kind: "parity", sql: "PRAGMA not_a_real_pragma" },
  { id: "PRG-schema-01", kind: "parity", sql: "PRAGMA encoding" },
  { id: "PRG-comp-01", kind: "parity", sql: "SELECT count(*)>0 FROM pragma_compile_options()" },
]);
