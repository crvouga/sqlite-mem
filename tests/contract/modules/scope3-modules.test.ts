import { expect } from "bun:test";
import { matrixBoth, expectParity } from "../../harness/index.ts";
import { parity } from "../helpers.ts";

matrixBoth("rtree create insert query", (memory, sqlite) => {
  for (const db of [memory, sqlite]) {
    expect(db.exec("CREATE VIRTUAL TABLE demo USING rtree(id, minX, maxX, minY, maxY)").ok).toBe(true);
    expect(db.exec("INSERT INTO demo VALUES(1, -80.604739, -80.604739, 39.659575, 39.659575)").ok).toBe(true);
    expect(db.exec("INSERT INTO demo VALUES(2, -81.0, -79.0, 38.0, 40.0)").ok).toBe(true);
  }
  expectParity(
    memory.query("SELECT id FROM demo WHERE maxX >= -80.7 AND minX <= -80.5 AND maxY >= 39.5 AND minY <= 39.8 ORDER BY id"),
    sqlite.query("SELECT id FROM demo WHERE maxX >= -80.7 AND minX <= -80.5 AND maxY >= 39.5 AND minY <= 39.8 ORDER BY id"),
  );
});

matrixBoth("fts3 MATCH", (memory, sqlite) => {
  for (const db of [memory, sqlite]) {
    expect(db.exec("CREATE VIRTUAL TABLE t3 USING fts3(content)").ok).toBe(true);
    expect(db.exec("INSERT INTO t3(content) VALUES ('hello sqlite world')").ok).toBe(true);
  }
  expectParity(
    memory.query("SELECT content FROM t3 WHERE t3 MATCH 'sqlite'"),
    sqlite.query("SELECT content FROM t3 WHERE t3 MATCH 'sqlite'"),
  );
});

matrixBoth("fts4 MATCH", (memory, sqlite) => {
  for (const db of [memory, sqlite]) {
    expect(db.exec("CREATE VIRTUAL TABLE t4 USING fts4(content)").ok).toBe(true);
    expect(db.exec("INSERT INTO t4(content) VALUES ('hello sqlite world')").ok).toBe(true);
  }
  expectParity(
    memory.query("SELECT content FROM t4 WHERE content MATCH 'sqlite'"),
    sqlite.query("SELECT content FROM t4 WHERE content MATCH 'sqlite'"),
  );
});

matrixBoth("dbstat virtual table", (memory, sqlite) => {
  for (const db of [memory, sqlite]) {
    expect(db.exec("CREATE TABLE t(x)").ok).toBe(true);
    expect(db.exec("INSERT INTO t VALUES (1)").ok).toBe(true);
    expect(db.exec("CREATE VIRTUAL TABLE temp.stat USING dbstat").ok).toBe(true);
  }
  expectParity(
    memory.query("SELECT name FROM temp.stat WHERE name = 't' LIMIT 1"),
    sqlite.query("SELECT name FROM temp.stat WHERE name = 't' LIMIT 1"),
  );
});

parity("rtreecheck ok", [
  "CREATE VIRTUAL TABLE demo USING rtree(id, minX, maxX, minY, maxY)",
  "INSERT INTO demo VALUES(1,0,1,0,1)",
], "SELECT rtreecheck('demo') AS v");

parity("fts5_source_id present", [], "SELECT length(fts5_source_id()) > 5 AS ok");
