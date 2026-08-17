# SQLite Compatibility Audit

```text
SQLite Compatibility Audit

Reference SQLite version:
  bun:sqlite (SQLite 3.51.0) via Bun 1.3.14

sqlite-mem version:
  0.1.0

Existing tests reviewed:
  87 contract test files under tests/contract/
  Shared harness: tests/harness/{normalize,assert,matrix,state-dump}.ts
  Adapters: tests/adapters/{in-memory,real-sqlite}.ts

Differential tests reviewed:
  ~382 parity/sequenceParity/errorParity/matrixBoth invocations
  12 fuzz files / 18 property tests (fast-check, seed 0x5a17e_0e1)

Features audited:
  SELECT/INSERT/UPDATE/DELETE/REPLACE/UPSERT/RETURNING
  Joins (INNER/LEFT/RIGHT/FULL/NATURAL/USING), subqueries, CTEs, recursive CTEs
  UNION/INTERSECT/EXCEPT, DISTINCT, GROUP BY/HAVING, aggregates, windows
  ORDER BY, LIMIT/OFFSET, CASE/CAST, NULL semantics, type affinity
  Scalar/date/aggregate/window functions, constraints, indexes, rowid
  Schema DDL/ALTER, views, transactions/savepoints, parameters
  PRAGMAs (schema + foreign_keys), foreign keys + cascades
  Conflict resolution, snapshot/restore (behavioral), FTS5 (partial)
  Prepared statements, error + post-mutation state dumps

New compatibility issues discovered:
  1. isTruthySql treated non-empty TEXT/BLOB as true (SQLite uses numeric cast)
  2. typeof(1.0) / CAST(... AS REAL) reported integer for integer-valued floats
  3. Aggregate result column names omitted arguments (sum() vs sum(v))
  4. FK cascade/SET NULL/SET DEFAULT did not include cascaded rows in changes()
  5. UPSERT ON CONFLICT(target) could apply to the wrong unique conflict and
     skip secondary UNIQUE enforcement on DO UPDATE
  6. Harness gaps: stale bun:sqlite write counters; sequenceParity wiped DML
     counters; errorParity ignored messages; empty result column metadata lost;
     duplicate column headers collapsed by bun object rows

Issues fixed:
  1. isTruthySql aligned with SQLite numeric truthiness
  2. SqlReal storage-class tag for float literals, CAST AS REAL, REAL affinity
  3. Aggregate/function expressionName includes argument names
  4. applyReferentialDelete/Update return cascaded change counts
  5. UPSERT resolves only ON CONFLICT target; other UNIQUE conflicts error
  6. RealSqliteAdapter uses prepare().run / values(); multi-statement exec path;
     sequenceParity compares DML counters; errorParity via deepCompareResults
     with category-preserving message normalization; positional values compare;
     dumpLogicalState helper; Statement.result() for empty-result columns

New regression tests:
  tests/contract/null/truthiness.test.ts
  tests/contract/types/typeof-real.test.ts
  tests/contract/upsert/unique-secondary.test.ts
  tests/contract/transactions/stateful.test.ts
  tests/contract/parameters/audit.test.ts
  tests/contract/errors/state.test.ts
  tests/contract/snapshots/basic.test.ts (clone lockstep + rowid continuity)
  tests/fuzz/combinations.test.ts
  tests/harness/normalize.test.ts
  Strengthened tests/fuzz/dml.test.ts + helpers (compareWriteOrReport, state dump)

Differential test count:
  436 tests passing under `bun test` (contract + fuzz + harness)
  ~382 explicit dual-backend helper invocations in contract suite

Randomized/stateful test count:
  18 fuzz property tests across 12 files
  1 long deterministic multi-op sequenceParity script (transactions/stateful)
  Combination fuzz: NULL+JOIN+GROUP BY; UPSERT+UNIQUE+txn

Fuzz cases:
  Seeded fast-check (SQLITE_MEM_FUZZ_SEED / SQLITE_MEM_FUZZ_PATH)
  DML sequences now full-compare successful writes + logical state dump
  compareOutcomeOrReport retained only for unspecified multi-constraint races

Mismatches remaining:
  None observed on the exercised differential surface after fixes.
  Known thin areas not claimed as complete SQLite: FTS internals beyond MATCH,
  autoindex catalog rows (sqlite_autoindex_*), EXPLAIN/INDEXED BY plan effects,
  BigInt beyond Number.MAX_SAFE_INTEGER without bun safeIntegers mode

Intentional/documented differences:
  Custom SQLM snapshot format (not .sqlite files)
  Deterministic random() / 'now' (seeded PRNG + fixed clock)
  generate_series memory-only (absent from stock bun:sqlite)
  FTS / virtual tables: partial (FTS5 + MATCH)
  INDEXED BY / NOT INDEXED accepted as no-ops (identity planner)
  Non-schema PRAGMAs mostly empty/no-op

Final compatibility assessment:
  Across the audited SQLite surface covered by the strengthened differential
  contract suite, seeded fuzz, stateful sequences, snapshot clone tests, and
  browser smoke (chromium/firefox/webkit), sqlite-mem and real SQLite (3.51.0)
  produce matching observable results for successful queries, DML metadata
  (changes/lastInsertRowid where drivers expose them), error categories, and
  post-mutation logical state. Every discrepancy found in this pass was fixed
  or explicitly documented as intentional/partial. This is evidence-based
  parity for the tested surface — not a claim of bit-identical SQLite C
  engine completeness.
```

Verification commands run:

```bash
bun test                 # 436 pass, 0 fail
bun run test:browser     # chromium, firefox, webkit smoke passed
bun run typecheck        # clean
```
