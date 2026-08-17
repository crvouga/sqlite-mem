import { errorParity, parity, sequenceParity } from "../helpers.ts";

const schema = [
  "PRAGMA foreign_keys=ON",
  "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
  "CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id))",
  "INSERT INTO parent VALUES (1)",
];

parity("foreign key accepts existing parent", [...schema, "INSERT INTO child VALUES (10,1)"], "SELECT * FROM child");
errorParity("foreign key rejects missing parent", schema, "INSERT INTO child VALUES (10,99)", "constraint_foreign");
parity("foreign key permits NULL child key", [...schema, "INSERT INTO child VALUES (10,NULL)"], "SELECT id,parent_id FROM child");
errorParity("parent delete is restricted", [...schema, "INSERT INTO child VALUES (10,1)"], "DELETE FROM parent WHERE id=1", "constraint_foreign");
sequenceParity("ON DELETE CASCADE removes child rows", [
  "PRAGMA foreign_keys=ON",
  "CREATE TABLE p(id INTEGER PRIMARY KEY)",
  "CREATE TABLE c(id INTEGER,parent_id INTEGER REFERENCES p(id) ON DELETE CASCADE)",
  "INSERT INTO p VALUES (1)",
  "INSERT INTO c VALUES (2,1)",
], [{ sql: "DELETE FROM p WHERE id=1" }, { sql: "SELECT * FROM c", query: true }]);
