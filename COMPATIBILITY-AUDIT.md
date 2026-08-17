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

SQLite features inventoried:
  Core DML/DDL/SELECT surface, constraints, transactions, windows, FTS5,
  JSON1/JSONB/TVFs/operators, pragma_function_list (~186 oracle entries),
  pragma_module_list (fts*/rtree/json_each/json_tree/…).

Features verified:
  SELECT/INSERT/UPDATE/DELETE/RETURNING/UPSERT, joins, CTEs, recursive CTEs,
  subqueries, compounds, aggregates, windows (common frames), affinity/NULL,
  constraints/FK cascades, triggers, views, ATTACH, WITHOUT ROWID, GENERATED,
  schema catalog queries, transactions/savepoints, core scalars/date/aggs,
  JSON1 + JSONB + ->/->> + json_each/json_tree, IS DISTINCT FROM,
  subtype().

Features partially verified:
  Window EXCLUDE / some frame edges; FILTER; WITH-on-DML; STRICT tables;
  partial/expression indexes; deferred FK; prepared-stmt schema invalidation;
  EXPLAIN/INDEXED BY (stubs/no-ops); non-schema PRAGMAs; FTS5 beyond MATCH;
  generate_series (memory-only).

Features unsupported:
  ENABLE_MATH_FUNCTIONS (sin/cos/pow/…); extra strings (instr/concat/unicode/…);
  unixepoch/timediff/string_agg/ntile/cume_dist/percent_rank/octet_length/…;
  FTS3/4, RTREE, dbstat, bytecode modules; VACUUM (not claimed);
  REGEXP (if treated as extension).

Features with insufficient tests:
  See PARTIALLY VERIFIED rows in COMPATIBILITY.md — deliberately not marked
  VERIFIED from single happy-path coverage.

JSON:
  JSON functions verified:
    json, json_array, json_object, json_quote, json_extract, json_insert,
    json_replace, json_set, json_remove, json_patch, json_type, json_valid,
    json_error_position, json_array_length, json_pretty, json_group_array,
    json_group_object, jsonb + jsonb_* counterparts, subtype, ->, ->>
  JSON table-valued functions verified:
    json_each, json_tree (columns key/value/type/atom/id/parent/fullkey/path;
    correlated joins; path-rooted ids)
  JSON path cases:
    $, .key, quoted keys, [n], [#-n], [#], unicode/unusual keys, malformed paths
  JSONB status:
    VERIFIED — authentic JSONB encode/decode (hex(jsonb('[1,2]'))=4B13311332)
  JSON fuzz cases:
    Seeded fast-check ops over random JSON (tests/fuzz/json.test.ts)

Differential tests:
  Total: 580 under `bun test` (contract + fuzz + harness)
  Passed: 580
  Failed: 0

Stateful tests:
  Total operations: multi-step sequenceParity scripts (transactions + JSON txn/view)
  Seeds: fuzz seed 0x5a17e_0e1 (override SQLITE_MEM_FUZZ_SEED / PATH)
  Mismatches: 0 after fixes

Fuzz tests:
  Generated cases: existing fuzz suite + JSON fuzz (40 runs/seed)
  Mismatches: 0 after json_set($[#]) on non-array hang fix

New compatibility bugs found:
  1. JSON1/JSONB entirely missing (largest gap vs oracle)
  2. No JSON subtype (74) — nesting semantics impossible
  3. No -> / ->> lexer/parser/eval
  4. json_each/json_tree absent; correlated TVF joins unsupported
  5. json_set('$[#]') on non-array infinite recursion
  6. ->> on arrays/objects incorrectly preserved JSON subtype
  7. IS NOT DISTINCT FROM parser consumed NOT without DISTINCT (broke IS NOT)
  8. Inventory gap: many ENABLE_MATH / string / window builtins absent

New bugs fixed:
  1–7 above implemented/fixed; #8 documented as UNSUPPORTED with inventory test

New regression tests:
  tests/contract/json/* (creation, extract, operators, modify, aggregates,
    inspect, paths, types, malformed, composition, tvf-each, tvf-tree,
    jsonb, generated-semantics, regressions)
  tests/fuzz/json.test.ts
  tests/contract/functions/inventory.test.ts
  tests/contract/expressions/distinct-from.test.ts
  scripts/sqlite-inventory.ts + `bun run inventory`

Remaining known differences:
  Custom SQLM snapshots; deterministic random()/'now';
  generate_series memory-only; FTS/vtable modules beyond FTS5;
  INDEXED BY no-ops; EXPLAIN stubs; non-schema PRAGMA empty/no-op;
  missing math/extra string/window builtins listed UNSUPPORTED;
  BigInt beyond Number.MAX_SAFE_INTEGER without bun safeIntegers.

Final assessment:
  JSON/JSONB is now differentially verified against SQLite 3.51.0 for the
  oracle-exposed API (scalars, aggregates, paths, operators, TVFs, JSONB
  hex/typeof round-trips, malformed inputs, composition, fuzz). The broader
  dialect surface remains evidence-based VERIFIED where contracts/fuzz are
  strong, with explicit PARTIALLY VERIFIED / UNSUPPORTED rows for gaps.
  This is not a claim of bit-identical SQLite C completeness — the matrix
  and inventory are the source of truth.
```

Verification commands run:

```bash
bun test                 # 580 pass, 0 fail
bun run test:browser     # chromium, firefox, webkit smoke passed
bun run typecheck        # clean
bun run inventory        # oracle vs registry dump
```
