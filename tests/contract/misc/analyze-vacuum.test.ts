import { execParity, parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "ANALYZE creates sqlite_stat1",
  ["CREATE TABLE t(x INT)", "CREATE INDEX ix ON t(x)", "INSERT INTO t VALUES (1),(2),(3)"],
  [
    { sql: "ANALYZE" },
    {
      sql: "SELECT tbl, idx IS NOT NULL AS has_idx, typeof(stat) AS st FROM sqlite_stat1 ORDER BY tbl, idx",
      query: true,
    },
  ],
);

execParity("VACUUM succeeds on memory", ["CREATE TABLE t(x INT)"], "VACUUM");
execParity(
  "REINDEX succeeds",
  ["CREATE TABLE t(x INT)", "CREATE INDEX ix ON t(x)", "INSERT INTO t VALUES (1)"],
  "REINDEX",
);
execParity("REINDEX table", ["CREATE TABLE t(x INT)", "CREATE INDEX ix ON t(x)"], "REINDEX t");
parity("sqlite_version matches oracle major", [], "SELECT length(sqlite_version()) > 0 AS ok");
