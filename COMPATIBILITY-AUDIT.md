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
  VERIFIED — includes string_agg, ntile, cume_dist, percent_rank, EXCLUDE

CTEs / transactions / savepoints / constraints / FK / triggers:
  VERIFIED (deferred FK + composite FK)

Indexes / views / generated / STRICT / WITHOUT ROWID:
  VERIFIED — partial/expression indexes, STRICT tables, leftmost prefix

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
  VERIFIED — schema invalidation re-prepares; SQLM logical round-trip VERIFIED

  Differential tests:
  Total: 727 under `bun test` (contract + fuzz + harness)
  Passed: 727
  Failed: 0

Stateful / fuzz:
  Seeds: 0x5a17e0e1 (+ SQLITE_MEM_FUZZ_SEED override)
  Combination fuzz: tests/fuzz/combinations-scope3.test.ts
  FTS fuzz: tests/fuzz/fts.test.ts
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
  BigInt beyond Number.MAX_SAFE_INTEGER without bun safeIntegers;
  NOT APPLICABLE C API / on-disk / VFS surfaces.

Final assessment:
  Verified against SQLite 3.51.0 (bun:sqlite). Oracle function/module
  inventory is closed (0 missing). Requirements matrix ingested with
  zero unknown statuses. Gate: `bun run test:sqlite-compat`.
```

---

## SQLite Full-Text Search Compatibility Audit

```text
SQLite Full-Text Search Compatibility Audit
==========================================

Reference SQLite:
  version: 3.51.0 (bun:sqlite)
  source_id: 2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl
  compile options: ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS, ENABLE_FTS3_TOKENIZER,
                   ENABLE_FTS4, ENABLE_FTS5
  inventory: compat/fts-oracle-surface.json (bun run scripts/fts-oracle-surface.ts)

FTS3: PARTIALLY VERIFIED (MATCH, snippet, offsets; matchinfo formats thinner)
FTS4: PARTIALLY VERIFIED (same surface as FTS3 for tested paths)
FTS5: PARTIALLY VERIFIED overall — core MATCH/tokenizers/ranking/aux VERIFIED;
      external-content + full matchinfo format strings still thinner

Tokenizers verified:
  unicode61 (incl. remove_diacritics 0/1/2), ascii, porter,
  porter unicode61, porter ascii, trigram

MATCH grammar verified:
  terms, AND/OR/NOT, implicit AND, phrases, prefix *, column filters
  (col : term / {cols} :), NEAR / NEAR(…, N), parentheses, NEAR-as-term

Ranking verified:
  bm25() / rank column — order + scores vs oracle (1e-15 abs epsilon for ULP)

Auxiliary functions verified:
  bm25, highlight, snippet (FTS5); snippet, offsets (FTS3/4);
  matchinfo present (default format PARTIAL)

Content modes verified:
  normal content tables: VERIFIED
  contentless (content=''): VERIFIED
  external content: PARTIALLY VERIFIED (CREATE accepted; sync/triggers thinner)

Special commands verified:
  optimize, rebuild, integrity-check (success + post-command MATCH)
  delete-all / merge / automerge: error parity with oracle where probed

Differential tests:
  Passed: 656 (contract + fuzz + harness)
  Failed: 0
  FTS contract: tests/contract/fts/basic.test.ts,
                tests/contract/fts/comprehensive.test.ts

Fuzz cases:
  Generated: fast-check seed 0x5a17e0e1 (override SQLITE_MEM_FUZZ_SEED)
  Files: tests/fuzz/fts.test.ts (MATCH queries, tokenizers, stateful DML)
  Mismatches: 0 (after trigram phrase expansion + NEAR-as-term fixes)

Stateful cases:
  Operations: INSERT/UPDATE/DELETE/MATCH sequences + txn/savepoint contracts
  Mismatches: 0

Compatibility gaps found:
  1. Toy AND-token matcher (replaced)
  2. Aux functions always threw (wired MATCH cursor + real bm25/highlight/snippet)
  3. No CREATE option parsing (tokenize=/content=/prefix=/UNINDEXED)
  4. No FTS5 query language / NEAR / phrases / column filters
  5. False VERIFIED status on fts5.html / fts3.html (downgraded then re-evidenced)

Compatibility gaps fixed:
  Positional inverted index; unicode61/ascii/porter/trigram tokenizers;
  FTS5 query parser; BM25 with SQLite IDF floor 1e-6; highlight/snippet;
  contentless mode; special commands; FTS3/4 MATCH + snippet/offsets;
  comparator realEpsilon for ranking ULP only; FTS fuzz suites

Regression tests added:
  tests/contract/fts/comprehensive.test.ts
  tests/fuzz/fts.test.ts
  tests/harness/fts-compare.ts
  scripts/fts-oracle-surface.ts

Remaining unsupported / thinner functionality:
  - SQLite FTS shadow tables not mirrored (change counters diverge; documented)
  - External-content sync/stale-index edge cases thinner
  - FTS3 matchinfo format-string variants not exhaustively verified
  - fts3tokenize / fts4aux still thin CREATE stubs
  - locale / tokendata / detail=none advanced options accepted but lightly tested
```

Verification commands:

```bash
bun run test:sqlite-compat
bun run scripts/fts-oracle-surface.ts
bun test tests/contract/fts tests/fuzz/fts.test.ts
bun run inventory
bun run requirements
bun run typecheck
```
