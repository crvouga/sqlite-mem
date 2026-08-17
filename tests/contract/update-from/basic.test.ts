import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "UPDATE FROM joins source rows",
  [
    "CREATE TABLE a(id INTEGER, v TEXT)",
    "CREATE TABLE b(id INTEGER, v TEXT)",
    "INSERT INTO a VALUES (1,'old'),(2,'keep')",
    "INSERT INTO b VALUES (1,'new')",
  ],
  [
    { sql: "UPDATE a SET v = b.v FROM b WHERE a.id = b.id" },
    { sql: "SELECT id, v FROM a ORDER BY id", query: true },
  ],
);
