import { errorParity, parity } from "../helpers.ts";

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

errorParity(
  "cannot insert into generated column (differential)",
  ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INT GENERATED ALWAYS AS (id+1) STORED)"],
  "INSERT INTO t(id, v) VALUES (1, 99)",
  "misuse",
);
