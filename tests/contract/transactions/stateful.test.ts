import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "long stateful script matches SQLite after each step",
  [],
  [
    { sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, qty INTEGER DEFAULT 0)" },
    { sql: "INSERT INTO items(name, qty) VALUES ('a', 1),('b', 2)" },
    { sql: "CREATE INDEX items_name ON items(name)" },
    { sql: "INSERT INTO items(name, qty) VALUES ('c', 3)" },
    { sql: "UPDATE items SET qty = qty + 1 WHERE name = 'a'" },
    { sql: "BEGIN" },
    { sql: "UPDATE items SET qty = 99 WHERE name = 'b'" },
    { sql: "SAVEPOINT sp1" },
    { sql: "DELETE FROM items WHERE name = 'c'" },
    { sql: "ROLLBACK TO sp1" },
    { sql: "INSERT INTO items(name, qty) VALUES ('d', 4)" },
    { sql: "RELEASE sp1" },
    { sql: "COMMIT" },
    { sql: "ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'n'" },
    { sql: "SELECT id, name, qty, note FROM items ORDER BY id", query: true },
    { sql: "DROP INDEX items_name" },
    { sql: "SELECT name, qty FROM items ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
