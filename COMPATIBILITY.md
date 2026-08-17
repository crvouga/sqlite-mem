# Compatibility

Behavioral compatibility is determined by the differential contract suite (`bun test`), which compares this engine against real SQLite via `bun:sqlite`.

Statuses:

- **yes** — covered by differential contract/fuzz tests and matching the oracle
- **partial** — supported for common cases; known gaps documented
- **no** — unsupported; raises an explicit `unsupported` error (contract-tested)

| Feature | Supported | SQLite-compatible | Notes |
| --- | ---: | ---: | --- |
| SELECT | yes | yes | Edge + fuzz coverage |
| INSERT | yes | yes | `DEFAULT VALUES`, multi-row, `INSERT SELECT`, OR IGNORE |
| UPDATE | yes | yes | |
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
| CROSS / INNER / LEFT JOIN | yes | yes | USING; multi-join; fuzz |
| RIGHT / FULL OUTER JOIN | no | no | Explicit unsupported |
| ORDER BY / GROUP BY / HAVING | yes | yes | Expression GROUP BY; positional `GROUP BY 1` |
| DISTINCT / LIMIT / OFFSET | yes | yes | |
| CASE / CAST / expressions | yes | yes | Bitwise, LIKE ESCAPE, GLOB |
| COLLATE | yes | partial | Explicit BINARY/NOCASE/RTRIM on comparisons, ORDER BY, UNIQUE index columns; declared column collation is not inherited implicitly |
| NULL semantics | yes | yes | |
| Type affinity / storage classes | yes | yes | INTEGER/REAL/TEXT/BLOB/NUMERIC |
| PRIMARY KEY (incl. composite) | yes | yes | |
| UNIQUE / NOT NULL / CHECK | yes | yes | Fuzzed |
| FOREIGN KEY | yes | yes | Immediate checks; ON DELETE/UPDATE CASCADE, SET NULL, SET DEFAULT, RESTRICT/NO ACTION; composite FK; `PRAGMA foreign_keys` |
| DEFAULT | yes | yes | |
| Transactions / SAVEPOINT | yes | yes | Snapshot-based rollback |
| Core scalar functions | yes | yes | Including printf/substr/replace/round edges |
| Aggregate functions | yes | yes | `COUNT(DISTINCT)`, empty tables, TOTAL vs SUM |
| Date/time functions | yes | yes | Fixed clock; modifiers |
| Window functions | yes | yes | Ranking, lag/lead, first/last/nth_value, frames, named windows |
| Parameters (`?`, `:name`, `@name`, `$name`) | yes | yes | Repeated `?` |
| rowid / INTEGER PRIMARY KEY | yes | yes | |
| sqlite_master / sqlite_schema | yes | yes | Ordered catalog queries |
| Snapshot / restore | yes | n/a | Versioned custom binary format (not `.sqlite` file format) |
| PRAGMA foreign_keys | yes | yes | Get/set ON/OFF/1/0 |
| Other PRAGMA | no | no | Unknown pragmas follow SQLite empty/no-op or error parity where tested |
| Triggers | no | no | Explicit unsupported |
| FTS / virtual tables | no | no | Explicit unsupported |
| ATTACH / DETACH | no | no | Explicit unsupported |
| UPDATE FROM | no | no | Explicit unsupported |
| GENERATED columns | no | no | Explicit unsupported |
| WITHOUT ROWID | no | no | Explicit unsupported |
| INDEXED BY / NOT INDEXED | no | no | Explicit unsupported |

## Intentional incompatibilities

1. **Snapshot format** — custom binary codec, not the on-disk SQLite database file format.
2. **Unsupported features** — listed `no` rows throw `SqliteError` category `unsupported` (see `tests/contract/errors/unsupported.test.ts`).
3. **Column COLLATE inheritance** — table-declared column collations are not applied automatically to every comparison; use explicit `COLLATE` or indexed-column collations.
4. **Deterministic `random()` / `'now'`** — seeded PRNG and fixed clock by default (injectable); not SQLite’s OS entropy/clock.

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

**Supported-subset claim:** features marked `yes`/`yes` are oracle-proven by differential contracts and seeded fuzz. Extensions marked `no` remain intentionally unsupported.
