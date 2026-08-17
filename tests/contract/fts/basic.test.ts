import { matrixBoth, expectParity } from "../../harness/index.ts";

function setup(db: { exec: (sql: string) => { ok: boolean } }): void {
  expect(db.exec("CREATE VIRTUAL TABLE t USING fts5(content)").ok).toBe(true);
  expect(db.exec("INSERT INTO t(content) VALUES ('hello world')").ok).toBe(true);
  expect(db.exec("INSERT INTO t(content) VALUES ('goodbye moon')").ok).toBe(true);
}

matrixBoth("FTS5 table MATCH on table name", (memory, sqlite) => {
  setup(memory);
  setup(sqlite);
  expectParity(
    memory.query("SELECT * FROM t WHERE t MATCH 'hello'"),
    sqlite.query("SELECT * FROM t WHERE t MATCH 'hello'"),
  );
});

matrixBoth("FTS5 column MATCH", (memory, sqlite) => {
  setup(memory);
  setup(sqlite);
  expectParity(
    memory.query("SELECT * FROM t WHERE content MATCH 'hello'"),
    sqlite.query("SELECT * FROM t WHERE content MATCH 'hello'"),
  );
});

matrixBoth("FTS5 multi-token AND semantics", (memory, sqlite) => {
  setup(memory);
  setup(sqlite);
  expectParity(
    memory.query("SELECT * FROM t WHERE t MATCH 'hello world'"),
    sqlite.query("SELECT * FROM t WHERE t MATCH 'hello world'"),
  );
});

matrixBoth("FTS5 no match returns empty", (memory, sqlite) => {
  setup(memory);
  setup(sqlite);
  expectParity(
    memory.query("SELECT * FROM t WHERE t MATCH 'missing'"),
    sqlite.query("SELECT * FROM t WHERE t MATCH 'missing'"),
  );
});

matrixBoth("DROP TABLE removes FTS virtual table", (memory, sqlite) => {
  expectParity(memory.exec("CREATE VIRTUAL TABLE t USING fts5(content)"), sqlite.exec("CREATE VIRTUAL TABLE t USING fts5(content)"));
  expectParity(memory.exec("DROP TABLE t"), sqlite.exec("DROP TABLE t"));
  expectParity(memory.exec("INSERT INTO t(content) VALUES ('x')"), sqlite.exec("INSERT INTO t(content) VALUES ('x')"));
});
