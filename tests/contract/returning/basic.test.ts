import { parity } from "../helpers.ts";

parity(
  "INSERT RETURNING star returns inserted rows",
  ["CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)"],
  "INSERT INTO users(name) VALUES ('Ada'),('Grace') RETURNING *",
);

parity(
  "UPDATE RETURNING returns selected columns",
  ["CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)", "INSERT INTO users VALUES (1,'Ada'),(2,'Grace')"],
  "UPDATE users SET name = upper(name) WHERE id = 2 RETURNING id, name",
);

parity(
  "DELETE RETURNING star returns deleted rows",
  ["CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)", "INSERT INTO users VALUES (1,'Ada'),(2,'Grace')"],
  "DELETE FROM users WHERE id = 1 RETURNING *",
);
