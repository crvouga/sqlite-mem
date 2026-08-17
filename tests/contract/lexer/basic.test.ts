import { parity, sequenceParity } from "../helpers.ts";

parity("unicode string literals roundtrip", [], "SELECT 'héllo 世界 🌍' AS text,length('héllo 世界 🌍') AS chars");
parity("quoted identifiers support spaces and punctuation", [
  "CREATE TABLE \"odd table\"(\"select value\" TEXT,\"hyphen-name\" INTEGER)",
  "INSERT INTO \"odd table\" VALUES ('ok',7)",
], "SELECT \"select value\",\"hyphen-name\" FROM \"odd table\"");
parity("escaped quote in string literal", [], "SELECT 'O''Reilly' AS publisher");
sequenceParity("line and block comments are ignored", ["CREATE TABLE t(id INTEGER)"], [
  { sql: "-- insert one\nINSERT INTO t VALUES (1) /* trailing block */" },
  { sql: "SELECT /* projected */ id FROM t -- done", query: true },
]);
parity("bracket and backtick quoted identifiers", [
  "CREATE TABLE [strange table](`weird column` TEXT)",
  "INSERT INTO [strange table] VALUES ('value')",
], "SELECT `weird column` FROM [strange table]");
