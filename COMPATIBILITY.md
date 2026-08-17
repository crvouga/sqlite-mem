# Compatibility

Behavioral compatibility is determined by the differential contract suite (`bun test`), which compares this engine against real SQLite via `bun:sqlite`.

Statuses:

- **yes** — covered by contract tests and matching the oracle
- **partial** — supported for common cases; known gaps documented
- **no** — unsupported; raises an explicit error

| Feature | Supported | SQLite-compatible | Notes |
| --- | ---: | ---: | --- |
| SELECT | yes | yes | Contract matrix |
| INSERT | yes | yes | Including `DEFAULT VALUES` |
| UPDATE | yes | yes | |
| DELETE | yes | yes | |
| REPLACE | yes | yes | |
| UPSERT / ON CONFLICT | yes | yes | |
| CREATE TABLE | yes | yes | |
| ALTER TABLE | yes | yes | RENAME TABLE/COLUMN, ADD COLUMN, DROP COLUMN |
| DROP TABLE | yes | yes | |
| CREATE / DROP INDEX | yes | yes | Enforced for UNIQUE |
| CREATE / DROP VIEW | yes | yes | |
| WITH / CTEs | yes | yes | Including shadowing |
| Recursive CTEs | yes | yes | |
| Subqueries | yes | yes | Scalar, IN, EXISTS, FROM, correlated |
| UNION / UNION ALL / INTERSECT / EXCEPT | yes | yes | |
| CROSS / INNER / LEFT JOIN | yes | yes | |
| RIGHT / FULL OUTER JOIN | no | no | Explicit `unsupported` error |
| ORDER BY / GROUP BY / HAVING | yes | yes | Expression GROUP BY; HAVING aliases |
| DISTINCT / LIMIT / OFFSET | yes | yes | |
| CASE / CAST / expressions | yes | yes | Integer division matches SQLite |
| NULL semantics | yes | yes | |
| Type affinity / storage classes | yes | yes | INTEGER/REAL/TEXT/BLOB/NUMERIC |
| PRIMARY KEY (incl. composite) | yes | yes | |
| UNIQUE / NOT NULL / CHECK | yes | yes | |
| FOREIGN KEY | yes | partial | Immediate checks with `PRAGMA foreign_keys=ON`; limited action coverage |
| DEFAULT | yes | yes | |
| Transactions / SAVEPOINT | yes | yes | Snapshot-based rollback |
| Core scalar functions | yes | yes | abs, coalesce, ifnull, nullif, typeof, length, lower/upper, trim*, substr, replace, round, hex, quote, printf, … |
| Aggregate functions | yes | yes | count, sum, avg, total, min, max, group_concat |
| Date/time functions | yes | yes | date, time, datetime, julianday, strftime |
| Window functions | yes | yes | row_number, rank, dense_rank, lag, lead, first/last/nth_value, aggregate windows |
| Parameters (`?`, `:name`) | yes | yes | |
| rowid / INTEGER PRIMARY KEY | yes | yes | `rowid` / `_rowid_` / `oid` |
| sqlite_master / sqlite_schema | yes | yes | |
| Snapshot / restore | yes | n/a | Versioned custom binary format (not `.sqlite` file format) |
| Triggers | no | no | Explicit `unsupported` error |
| FTS / virtual tables | no | no | Explicit `unsupported` error |
| ATTACH / DETACH | no | no | Explicit `unsupported` error |
| PRAGMA | partial | partial | `foreign_keys` supported |

## Intentional incompatibilities

1. **Snapshot format** — `snapshot()` / `restore()` use a project-specific binary codec, not the on-disk SQLite database file format.
2. **Unsupported DDL** — `CREATE VIRTUAL TABLE`, `CREATE TRIGGER`, `ATTACH`/`DETACH` throw `SqliteError` with category `unsupported` rather than partially faking behavior.
3. **RIGHT/FULL JOIN** — parsed enough to reject with an explicit unsupported error.
4. **Foreign-key actions** — common immediate FK violations are enforced; cascading/`SET NULL` action coverage is narrower than SQLite.

## Determinism

The production engine never calls `Math.random`, `crypto.getRandomValues`, or the system clock.

- `random()` uses a seeded xorshift64* PRNG (`Database({ seed })`, default `1`)
- Date/time `'now'` uses a fixed clock (`2000-01-01T00:00:00.000Z`) unless overridden
- Snapshots encode tables/views/indexes/rows in sorted order

Property tests are seeded via `SQLITE_MEM_FUZZ_SEED` / `SQLITE_MEM_FUZZ_PATH` (see README).

## How to verify

```bash
bun test                 # contract + fuzz vs bun:sqlite
bun run test:browser     # Playwright smoke on Chromium/Firefox/WebKit
```

Do not treat isolated unit tests of internal modules as proof of SQLite compatibility. The matrix runner is authoritative.
