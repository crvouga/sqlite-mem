# Compatibility

Goal: **full SQLite3 SQL dialect behavioral parity** as a drop-in for the same statements. Compatibility is proven by the differential contract suite (`bun test`) against real SQLite via `bun:sqlite`.

Statuses:

- **yes** — covered by differential contract/fuzz tests and matching the oracle
- **partial** — supported for common cases; known gaps documented
- **no** — not yet implemented; raises an explicit `unsupported` error until closed

| Feature | Supported | SQLite-compatible | Notes |
| --- | ---: | ---: | --- |
| SELECT | yes | yes | Edge + fuzz coverage |
| INSERT | yes | yes | `DEFAULT VALUES`, multi-row, `INSERT SELECT`, OR IGNORE |
| UPDATE | yes | yes | Including `UPDATE … FROM` |
| DELETE | yes | yes | |
| RETURNING | yes | yes | INSERT / UPDATE / DELETE |
| REPLACE | yes | yes | |
| UPSERT / ON CONFLICT | yes | yes | Composite targets; `excluded.*`; fuzz |
| CREATE TABLE | yes | yes | Including `CREATE TABLE AS SELECT` |
| ALTER TABLE | yes | yes | RENAME TABLE/COLUMN, ADD COLUMN, DROP COLUMN |
| DROP TABLE | yes | yes | |
| CREATE / DROP INDEX | yes | yes | UNIQUE indexes enforced |
| CREATE / DROP VIEW | yes | yes | |
| WITH / CTEs | yes | yes | Shadowing; fuzz |
| Recursive CTEs | yes | yes | `UNION`/`UNION ALL`; deep recursion |
| Subqueries | yes | yes | Scalar, IN, EXISTS, FROM, correlated |
| UNION / UNION ALL / INTERSECT / EXCEPT | yes | yes | |
| CROSS / INNER / LEFT JOIN | yes | yes | USING; NATURAL; multi-join; fuzz |
| RIGHT / FULL OUTER JOIN | yes | yes | Nested-loop; contracts |
| ORDER BY / GROUP BY / HAVING | yes | yes | Expression GROUP BY; positional `GROUP BY 1` |
| DISTINCT / LIMIT / OFFSET | yes | yes | |
| CASE / CAST / expressions | yes | yes | Bitwise, LIKE ESCAPE, GLOB; CAST type params |
| COLLATE | yes | yes | Explicit BINARY/NOCASE/RTRIM; column collation inherited on comparisons / ORDER BY / UNIQUE |
| NULL semantics | yes | yes | |
| Type affinity / storage classes | yes | yes | INTEGER/REAL/TEXT/BLOB/NUMERIC |
| PRIMARY KEY (incl. composite) | yes | yes | `AUTOINCREMENT` accepted; keys do not reuse deleted ids |
| UNIQUE / NOT NULL / CHECK | yes | yes | Fuzzed |
| FOREIGN KEY | yes | yes | Immediate checks; ON DELETE/UPDATE CASCADE, SET NULL, SET DEFAULT, RESTRICT/NO ACTION; composite FK; `PRAGMA foreign_keys`; fuzz |
| DEFAULT | yes | yes | |
| Transactions / SAVEPOINT | yes | yes | Snapshot-based rollback; fuzz |
| Core scalar functions | yes | yes | Including printf/substr/replace/round edges; scalar min/max; zeroblob; changes(); CURRENT_DATE/TIME/TIMESTAMP |
| Aggregate functions | yes | yes | `COUNT(DISTINCT)`, empty tables, TOTAL vs SUM, group_concat |
| Date/time functions | yes | yes | Fixed clock; modifiers |
| Window functions | yes | yes | Ranking, lag/lead, first/last/nth_value, frames, named windows; fuzz |
| Parameters (`?`, `:name`, `@name`, `$name`) | yes | yes | Repeated `?` |
| rowid / INTEGER PRIMARY KEY | yes | yes | |
| sqlite_master / sqlite_schema | yes | yes | Ordered catalog queries |
| Snapshot / restore | yes | n/a | Versioned custom binary format (not `.sqlite` file format) |
| PRAGMA foreign_keys | yes | yes | Get/set ON/OFF/1/0 |
| Schema PRAGMAs | yes | yes | `table_info`, `table_xinfo`, `index_list`, `index_info`, `foreign_key_list`, `database_list`, `user_version` / `schema_version`; other pragmas empty/no-op |
| Triggers | yes | yes | BEFORE/AFTER/INSTEAD OF; OLD/NEW; WHEN; RAISE; contracts |
| FTS / virtual tables | yes | partial | FTS5 module + MATCH; other virtual-table modules not yet implemented |
| ATTACH / DETACH | yes | yes | In-memory attached schemas; schema-qualified names |
| UPDATE FROM | yes | yes | |
| GENERATED columns | yes | yes | VIRTUAL / STORED |
| WITHOUT ROWID | yes | yes | Clustered primary-key storage |
| INDEXED BY / NOT INDEXED | yes | yes | Accepted as no-ops (planner is identity) |
| MATCH operator | yes | yes | FTS5 MATCH; non-FTS tables error like SQLite |
| Table-valued functions | yes | partial | Builtin `generate_series` (not in stock bun:sqlite; memory-tested) |

## Intentional incompatibilities

1. **Snapshot format** — custom binary codec (`SQLM`), not the on-disk SQLite database file format.
2. **Deterministic `random()` / `'now'`** — seeded PRNG and fixed clock by default (injectable); not SQLite’s OS entropy/clock.

## Determinism

The production engine never calls `Math.random`, `crypto.getRandomValues`, or the system clock.

- `random()` uses a seeded xorshift64* PRNG (`Database({ seed })`, default `1`)
- Date/time `'now'` uses a fixed clock (`2000-01-01T00:00:00.000Z`) unless overridden
- Snapshots encode schema/rows in deterministic order

Property tests are seeded via `SQLITE_MEM_FUZZ_SEED` / `SQLITE_MEM_FUZZ_PATH` (see README).

## How to verify

```bash
bun test                 # contract + fuzz vs bun:sqlite
bun run test:browser     # Playwright smoke on Chromium/Firefox/WebKit
```

Do not treat isolated unit tests of internal modules as proof of SQLite compatibility. The matrix runner is authoritative.

**Parity claim:** features marked `yes`/`yes` are oracle-proven by differential contracts and seeded fuzz. Remaining `partial` rows document known module gaps on the path to full SQLite3 dialect coverage.
