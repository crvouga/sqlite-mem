# Compatibility

Goal: **full SQLite3 SQL dialect behavioral parity** as a drop-in for the same statements. Compatibility is proven by the differential contract suite (`bun test`) against real SQLite via `bun:sqlite`.

See [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) for the latest evidence-based audit report.

Reference oracle: **SQLite 3.51.0** (`bun:sqlite`). Inventory: `bun run inventory`.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Differential contracts (+ fuzz where applicable) cover happy path **and** meaningful edges vs oracle |
| **PARTIALLY VERIFIED** | Implemented; coverage thin or known gaps remain |
| **UNSUPPORTED** | Missing or intentionally not claimed |
| **NOT APPLICABLE** | Outside the in-memory dialect surface (e.g. on-disk `.sqlite` format) |

Columns below: Feature | sqlite-mem | Diff tests | Edge coverage | Status | Notes

## Core SQL / DML / queries

| Feature | Support | Diff | Edges | Status | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| SELECT | yes | yes | yes | VERIFIED | `tests/contract/select`, fuzz |
| INSERT | yes | yes | yes | VERIFIED | multi-row, SELECT, OR IGNORE |
| UPDATE / UPDATE FROM | yes | yes | yes | VERIFIED | |
| DELETE | yes | yes | yes | VERIFIED | |
| RETURNING | yes | yes | yes | VERIFIED | |
| REPLACE | yes | yes | yes | VERIFIED | |
| UPSERT / ON CONFLICT | yes | yes | yes | VERIFIED | fuzz + secondary unique |
| WITH / CTEs | yes | yes | yes | VERIFIED | |
| Recursive CTEs | yes | yes | yes | VERIFIED | |
| Subqueries | yes | yes | yes | VERIFIED | |
| UNION / INTERSECT / EXCEPT | yes | yes | yes | VERIFIED | |
| Joins (INNER/LEFT/RIGHT/FULL/CROSS/NATURAL/USING) | yes | yes | yes | VERIFIED | |
| ORDER BY / GROUP BY / HAVING | yes | yes | yes | VERIFIED | NULLS FIRST/LAST |
| DISTINCT / LIMIT / OFFSET | yes | yes | yes | VERIFIED | |
| CASE / CAST / expressions | yes | yes | yes | VERIFIED | bitwise, LIKE ESCAPE, GLOB |
| COLLATE | yes | yes | yes | VERIFIED | BINARY/NOCASE/RTRIM |
| NULL semantics | yes | yes | yes | VERIFIED | truthiness contracts |
| Type affinity / storage classes | yes | yes | yes | VERIFIED | |
| Parameters (`?`, `:name`, `@`, `$`) | yes | yes | yes | VERIFIED | |
| Prepared statements | yes | yes | partial | PARTIALLY VERIFIED | schema-change invalidation thin |
| IS DISTINCT FROM | yes | yes | yes | VERIFIED | `tests/contract/expressions/distinct-from.test.ts` |
| FILTER (aggregates) | yes | thin | thin | PARTIALLY VERIFIED | |
| Window frames / EXCLUDE | yes | yes | partial | PARTIALLY VERIFIED | common frames VERIFIED; EXCLUDE thinner |
| WITH on DML | yes | thin | thin | PARTIALLY VERIFIED | |

## Schema / constraints

| Feature | Support | Diff | Edges | Status | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| CREATE / DROP TABLE | yes | yes | yes | VERIFIED | CTAS |
| ALTER TABLE | yes | yes | yes | VERIFIED | RENAME/ADD/DROP COLUMN |
| CREATE / DROP INDEX | yes | yes | yes | VERIFIED | UNIQUE |
| Partial / expression indexes | yes | thin | thin | PARTIALLY VERIFIED | |
| Views | yes | yes | yes | VERIFIED | |
| PRIMARY KEY / AUTOINCREMENT | yes | yes | yes | VERIFIED | |
| UNIQUE / NOT NULL / CHECK | yes | yes | yes | VERIFIED | fuzz |
| FOREIGN KEY + actions | yes | yes | yes | VERIFIED | immediate; deferred thinner |
| GENERATED columns | yes | yes | yes | VERIFIED | VIRTUAL/STORED |
| STRICT tables | yes | thin | thin | PARTIALLY VERIFIED | |
| WITHOUT ROWID | yes | yes | yes | VERIFIED | |
| Triggers | yes | yes | yes | VERIFIED | |
| Temporary tables | yes | yes | yes | VERIFIED | |
| ATTACH / DETACH | yes | yes | yes | VERIFIED | in-memory schemas |
| sqlite_master / sqlite_schema | yes | yes | yes | VERIFIED | autoindex catalog rows incomplete |

## Transactions / pragmas / misc

| Feature | Support | Diff | Edges | Status | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| Transactions / SAVEPOINT | yes | yes | yes | VERIFIED | stateful + fuzz |
| PRAGMA foreign_keys | yes | yes | yes | VERIFIED | |
| Schema PRAGMAs | yes | yes | partial | PARTIALLY VERIFIED | listed info pragmas; others empty/no-op |
| EXPLAIN / EXPLAIN QUERY PLAN | yes | thin | no | PARTIALLY VERIFIED | stub opcodes; not plan-identical |
| INDEXED BY / NOT INDEXED | yes | yes | n/a | PARTIALLY VERIFIED | accepted as no-ops |
| VACUUM | no | — | — | UNSUPPORTED | in-memory no-op not claimed |
| Snapshot / restore | yes | yes | yes | NOT APPLICABLE | custom SQLM format (not `.sqlite`) |

## Functions

| Feature | Support | Diff | Edges | Status | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| Core scalars (abs, typeof, printf, …) | yes | yes | yes | VERIFIED | |
| Date/time | yes | yes | yes | VERIFIED | fixed clock |
| Aggregates | yes | yes | yes | VERIFIED | |
| Window ranking / lag/lead / nth | yes | yes | yes | VERIFIED | |
| `subtype()` | yes | yes | yes | VERIFIED | needed for JSON |
| JSON1 + JSONB + `->`/`->>` | yes | yes | yes | VERIFIED | see JSON section |
| `json_each` / `json_tree` | yes | yes | yes | VERIFIED | correlated TVF joins |
| Math (`sin`, `pow`, …) | no | inventory | — | UNSUPPORTED | oracle has ENABLE_MATH_FUNCTIONS |
| Extra strings (`instr`, `concat`, `unicode`, …) | no | inventory | — | UNSUPPORTED | |
| `unixepoch` / `timediff` / `string_agg` / `ntile` / … | no | inventory | — | UNSUPPORTED | see inventory |
| `generate_series` | yes | memory | — | PARTIALLY VERIFIED | memory-only (absent from stock bun:sqlite) |

## Virtual tables / extensions

| Feature | Support | Diff | Edges | Status | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| FTS5 + MATCH | yes | yes | partial | PARTIALLY VERIFIED | |
| FTS3/4, RTREE, dbstat, bytecode | no | — | — | UNSUPPORTED | |
| REGEXP / MATCH (non-FTS) | no / FTS only | yes | — | UNSUPPORTED / VERIFIED | non-FTS MATCH errors |

## JSON (SQLite 3.51.0 surface)

| Feature | Support | Diff | Edges | Status | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| `json` / `json_array` / `json_object` / `json_quote` | yes | yes | yes | VERIFIED | subtype nesting |
| `json_extract` / paths / `->` / `->>` | yes | yes | yes | VERIFIED | |
| `json_insert` / `replace` / `set` / `remove` / `patch` | yes | yes | yes | VERIFIED | |
| `json_type` / `valid` / `error_position` / `array_length` / `pretty` | yes | yes | yes | VERIFIED | |
| `json_group_array` / `json_group_object` | yes | yes | yes | VERIFIED | |
| JSONB (`jsonb*` + hex round-trip) | yes | yes | yes | VERIFIED | authentic JSONB codec |
| `json_each` / `json_tree` | yes | yes | yes | VERIFIED | column set + ids/parents |
| Malformed JSON / path errors | yes | yes | yes | VERIFIED | |
| JSON fuzz | yes | yes | yes | VERIFIED | `tests/fuzz/json.test.ts` |

## Intentional incompatibilities

1. **Snapshot format** — custom binary codec (`SQLM`), not the on-disk SQLite database file format.
2. **Deterministic `random()` / `'now'`** — seeded PRNG and fixed clock by default (injectable).

## Determinism

The production engine never calls `Math.random`, `crypto.getRandomValues`, or the system clock.

- `random()` uses a seeded xorshift64* PRNG (`Database({ seed })`, default `1`)
- Date/time `'now'` uses a fixed clock (`2000-01-01T00:00:00.000Z`) unless overridden
- Snapshots encode schema/rows in deterministic order

Property tests: `SQLITE_MEM_FUZZ_SEED` / `SQLITE_MEM_FUZZ_PATH` (see README).

## How to verify

```bash
bun test                 # contract + fuzz vs bun:sqlite
bun run test:browser     # Playwright smoke
bun run inventory        # oracle function/module inventory vs registries
```

Do not treat isolated unit tests of internal modules as proof of SQLite compatibility. The matrix runner is authoritative.

**Parity claim:** features marked **VERIFIED** are oracle-proven by differential contracts and seeded fuzz. **PARTIALLY VERIFIED** / **UNSUPPORTED** rows must not be marketed as full SQLite completeness.
