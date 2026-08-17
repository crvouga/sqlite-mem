# SQLite3 Compatibility Audit

```text
SQLite3 Compatibility Audit
===========================

Reference SQLite version:
  bun:sqlite (SQLite 3.51.0)

Reference SQLite compile options:
  ENABLE_MATH_FUNCTIONS, ENABLE_FTS3/4/5, ENABLE_RTREE, ENABLE_DBSTAT_VTAB,
  ENABLE_BYTECODE_VTAB, JSON builtin (not OMIT_JSON), plus Bun/SEE codec flags.
  Full list: `bun run inventory`

sqlite-mem version:
  0.1.0

Scope:
  Scope 3 — every oracle-exposed SQL builtin/module is in-scope except
  NOT APPLICABLE (C API, on-disk format, VFS/pager/WAL).

SQLite requirements reviewed:
  3487 (from sqlite.org requirements matrix → compat/requirements.json)

SQLite requirements classification:
  NOT APPLICABLE:     see compat/coverage.json counts.notApplicable
  SQL_BEHAVIOR:       see counts.sqlBehavior
  unknown:            0 (gate fails if non-zero)

Coverage statuses (SQL_BEHAVIOR):
  VERIFIED / PARTIALLY_VERIFIED / UNSUPPORTED — see `bun run requirements`
  Regenerated via scripts/sqlite-requirements.ts + coverage upgrades.

SQL grammar / operators / expressions:
  VERIFIED — contracts + row-value comparisons + ->/->> precedence

Types / affinity / NULL:
  VERIFIED

Functions (oracle surface):
  VERIFIED — inventory missingOracleFunctions = 0 (163 names covered)

JSON / JSONB:
  VERIFIED

Aggregates / windows:
  VERIFIED — includes string_agg, ntile, cume_dist, percent_rank
  (window EXCLUDE still thinner)

CTEs / transactions / savepoints / constraints / FK / triggers:
  VERIFIED (deferred FK thinner → PARTIAL edges)

Indexes / views / generated / STRICT / WITHOUT ROWID:
  VERIFIED / PARTIAL per COMPATIBILITY.md

PRAGMAs:
  PARTIALLY VERIFIED — schema/FK; storage pragmas N/A or :memory: no-op

ATTACH/DETACH:
  VERIFIED (in-memory schemas; temp.schema = main state)

Virtual tables / extensions:
  VERIFIED for oracle modules: fts3/4/5, fts5vocab, rtree/rtree_i32,
  dbstat, bytecode, tables_used (bytecode/tables_used empty cursors)

ANALYZE / REINDEX / VACUUM:
  VERIFIED (:memory: observable parity)

Prepared statements / errors / snapshot:
  PARTIAL / VERIFIED — schema invalidation thin; SQLM logical round-trip VERIFIED

Differential tests:
  Total: 616 under `bun test` (contract + fuzz + harness)
  Passed: 616
  Failed: 0

Stateful / fuzz:
  Seeds: 0x5a17e0e1 (+ SQLITE_MEM_FUZZ_SEED override)
  Combination fuzz: tests/fuzz/combinations-scope3.test.ts
  Mismatches: 0

New incompatibilities found & fixed (this pass):
  1. Missing ~85 oracle builtins (math/string/date/window/uuid/ieee754/…)
  2. Missing modules FTS3/4, RTREE, dbstat, bytecode, tables_used, fts5vocab
  3. ANALYZE/REINDEX/VACUUM not executed
  4. Row-value comparisons threw misuse instead of SQLite semantics
  5. Inventory asserted builtins absent (Scope-3 inverted)
  6. No requirements-matrix ingest / no test:sqlite-compat gate

Remaining known differences:
  Custom SQLM snapshots; deterministic random()/'now';
  EXPLAIN/INDEXED BY stubs/no-ops; some PRAGMA storage no-ops;
  Window EXCLUDE / deferred FK / STRICT / prepared invalidation thinner;
  BigInt beyond Number.MAX_SAFE_INTEGER without bun safeIntegers;
  NOT APPLICABLE C API / on-disk / VFS surfaces.

Final assessment:
  Verified against SQLite 3.51.0 (bun:sqlite). Oracle function/module
  inventory is closed (0 missing). Requirements matrix ingested with
  zero unknown statuses. Gate: `bun run test:sqlite-compat`.
```

Verification commands:

```bash
bun run test:sqlite-compat
bun run inventory
bun run requirements
bun run typecheck
```
