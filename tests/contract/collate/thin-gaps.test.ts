import { errorParity, parity } from "../helpers.ts";

parity(
  "GROUP BY applies explicit NOCASE collation",
  ["CREATE TABLE t(v TEXT)", "INSERT INTO t VALUES ('a'),('A'),('b')"],
  "SELECT v COLLATE NOCASE AS key,count(*) AS n FROM t GROUP BY v COLLATE NOCASE ORDER BY 1 COLLATE NOCASE",
);

parity(
  "JOIN comparison applies explicit NOCASE collation",
  [
    "CREATE TABLE a(v TEXT)",
    "CREATE TABLE b(v TEXT)",
    "INSERT INTO a VALUES ('alpha')",
    "INSERT INTO b VALUES ('ALPHA')",
  ],
  "SELECT a.v,b.v FROM a JOIN b ON a.v=b.v COLLATE NOCASE",
);

parity(
  "BETWEEN applies explicit NOCASE collation",
  [],
  "SELECT 'B' BETWEEN 'a' COLLATE NOCASE AND 'c' COLLATE NOCASE AS inside",
);

errorParity(
  "CHECK expression applies explicit NOCASE collation",
  ["CREATE TABLE t(v TEXT CHECK(v='ok' COLLATE NOCASE))"],
  "INSERT INTO t VALUES ('no')",
  "constraint_check",
);
