# SQLite-mem Performance Overhaul

## Environment

- Browser: Chromium 151.0.7922.34 (Playwright)
- Device/profile: desktop (unthrottled) and **Moto G4 + 4× CPU throttle** (low-end mobile proxy)
- CPU: host Darwin arm64; mobile numbers use Chromium CPU throttling, not a physical phone
- Memory: Bun `process.memoryUsage()`; Chromium `performance.memory` (quantized, limited)
- Runtime: Bun 1.3.14 (benchmarks + `bun:sqlite` 3.51.0 oracle); browser ESM bundle of sqlite-mem (no WASM)

Commands:

```bash
bun run benchmark
bun run benchmark:browser
bun run benchmark:bun
bun run benchmark:ci
```

## Baseline

Unoptimized engine (full table scan for every `WHERE`, `IndexStore` uniqueness-only, snapshot `number[]` writer, `restore()` cloned twice). CI-tier, Bun, sqlite-mem:

| Benchmark | p50 | p95 | ops/sec |
| --- | --- | --- | --- |
| PK lookup / 1000 rows (20 lookups) | 11.3 ms | 12.0 ms | 1,763 |
| Unique email index lookup / 1000 | 11.8 ms | 12.7 ms | 1,684 |
| Prepared 1000 PK executes | 578 ms | 793 ms | 1,619 |
| App queries / 200 users | 96 ms | 101 ms | 10 |
| Join small⋈large / 1000 | 10.2 ms | 10.4 ms | 98 |
| CRUD loop ×50 | 18.9 ms | 19.3 ms | 2,652 |
| Snapshot export ~1 MB | 26.1 ms | 29.2 ms | 37 |
| Snapshot hydrate ~1 MB | 1.60 ms | 2.15 ms | 571 |
| 1000 inserts in a transaction | 324 ms | 513 ms | 3,084 |

Same CI suite vs `bun:sqlite` (timing only): PK lookups ~1.86M/sec, prepared executes ~2.1M/sec, 1 MB serialize ~0.28 ms. sqlite-mem was **~100–1000×** slower on point lookups.

Mobile (Moto G4, 4× throttle) baseline:

| Benchmark | p95 |
| --- | --- |
| Prepared 1000 PK executes | 1578 ms |
| App queries / 200 users | 356 ms |
| PK lookup / 1000 rows | 34 ms |
| Snapshot export 1 MB | 100 ms |
| Snapshot hydrate 1 MB | 7.4 ms |

**Bundle (pre-opt):** 383 KB uncompressed / 76 KB gzip / 63 KB brotli.

### Top bottlenecks (from architecture + baseline)

1. **SELECT never used indexes or INTEGER PRIMARY KEY maps** — every `WHERE id = ?` scanned and sorted the table (~30–40%+ of interactive CPU; 1000× vs SQLite on point lookups)
2. **Nested-loop joins** fully materialized both sides even with a unique index on the probe key
3. **`Table.scan()` copied + sorted on every scan**
4. **Snapshot `Writer` built a `number[]` of every byte** (~8× peak vs payload) then `Uint8Array.from`
5. **`restore()` decoded then `replaceWith()` cloned the entire state again**
6. **GROUP BY / DISTINCT used `findIndex` (quadratic)**
7. **Prepared statements re-tokenized SQL to bind named parameters on every execute**
8. **Uncorrelated `col = (SELECT …)` re-evaluated the subquery per scanned row**

## Optimizations

| Optimization | Before (Bun p95) | After (Bun p95) | Improvement | Memory |
| --- | --- | --- | --- | --- |
| PK / unique index point lookup | 12.0 ms / 12.7 ms | 0.058 ms / 0.097 ms | ~200× / ~130× | fewer scan allocations |
| Prepared 1000 PK executes | 793 ms | 3.0 ms | ~260× | heap Δ 18 MB → ~0.1 MB |
| Indexed nested-loop join 1000 | 10.4 ms | 0.081 ms | ~130× | no full right-side materialize |
| App queries / 200 users | 101 ms | 3.2 ms | ~32× | join probe + assignee index |
| Snapshot export ~1 MB | 29.2 ms | 2.6 ms | ~11× | growable `Uint8Array`, no `number[]` |
| Snapshot hydrate ~1 MB | 2.15 ms | 1.41 ms | ~1.5× | `replaceWith({ adopt: true })` |
| Snapshot round-trip 1 MB | 29.4 ms | 3.7 ms | ~8× | combined |
| CRUD loop | 19.3 ms | 8.4 ms | ~2.3× | PK lookups in the loop |
| Uncorrelated subquery PK | 6.6 ms | 0.17 ms | ~40× | eval subquery once |

Engine changes (semantics preserved; differential suite green):

- `IndexStore` supports non-unique multi-rowid entries and `lookup()`
- Equality `WHERE` / `UPDATE` / `DELETE` use INTEGER PRIMARY KEY maps or secondary indexes
- INNER/LEFT joins probe the right table via PK or index when `ON` is column equality
- Cached sorted `Table.scan()`
- Hash GROUP BY / DISTINCT
- Named-parameter token plan cached on `Statement`
- SQLM writer uses a growable `Uint8Array`; restore adopts decoded state
- Uncorrelated equality RHS (including scalar subqueries) evaluated once for access-path selection

SQLM v2 layout is unchanged. Public API is unchanged.

## Final results

### Bun (CI tier, sqlite-mem)

- Point lookup p50 / p95 / p99 (1000 rows, 20 ops): **0.047 / 0.058 / 0.058 ms**
- Prepared 1000 executes: **2.37 / 2.99 / 2.99 ms** (~400k/sec)
- Inserts/sec (1000 INTEGER PK + secondary index): **~237,000** (`hotspot/insert-pk/1000`; previously ~3,200 on the unconstrained TX insert bench)
- Snapshot 1 MB export p95 **2.6 ms** (~0.5 GB/s equivalent on this host); hydrate p95 **1.4 ms**

### Mobile (Chromium Moto G4, 4× throttle)

- PK lookup 1000 rows p95 **0.47 ms**
- Prepared 1000 executes p95 **9.4 ms** (~114k/sec)
- App queries p95 **12 ms**
- CRUD loop p95 **28 ms**
- Snapshot 1 MB export p95 **12 ms** (~89 MB/sec); hydrate p95 **8.2 ms** (~127 MB/sec)

### vs bun:sqlite (cost of pure TypeScript)

After the overhaul, PK lookups are about **4–5×** slower than native SQLite in Bun (was ~1000×). Batched INTEGER PK inserts with a secondary index are ~237k/sec on this host (~70× the previous ~3,200/sec TX insert bench), still well short of native insert parity (needs a row-representation rewrite). Snapshot export of ~1 MB is still slower than `serialize()` but no longer dominated by a JS `number[]` byte buffer.

### Bundle size

- uncompressed **395 KB**
- gzip **79 KB**
- brotli **65 KB**

## Target status

See [TARGETS.md](TARGETS.md). All listed mobile interactive / snapshot / bundle targets **PASS**.

Insert throughput for INTEGER PK + secondary index is **~70×** the previous ~3,200/sec TX insert bench via copy-on-write transactions and less Map churn. Native insert parity still needs a row-representation rewrite.

## Hotspot production pass (Bun, darwin)

Indexed range / prefix / `ORDER BY LIMIT` at 1000 rows are no longer scan-class:

| Spec | p95 | Notes |
| --- | --- | --- |
| `hotspot/range-gt/1000` | 0.36 ms | ~5× faster than unindexed scan (1.74 ms) |
| `hotspot/between/1000` | 0.08 ms | ordered IndexStore |
| `hotspot/order-limit/1000` | walks the index then LIMIT | not a full sort of all rows |
| `hotspot/index-prefix/1000` | 1.29 ms | leftmost prefix of `(a,b)` |
| `hotspot/tx-begin/1000` | 0.03 ms | copy-on-write; not a full row clone |
| `hotspot/insert-pk/1000` | ~237k inserts/sec | ≥10× the previous ~3,200/sec TX insert bench |

CI records `benchmarks/results/ci-baseline.json`. The regression gate **fails closed** if that file was recorded on a different OS than the runner (GitHub Actions is linux). Re-record on ubuntu and commit the file (or download the `ci-latest-linux` workflow artifact).

## Snapshot Performance

| | Baseline (Bun) | After (Bun) | After (mobile 4×) |
| --- | --- | --- | --- |
| Database | 1000 × 1 KB payload | same | same |
| Snapshot size | 1,051,507 B | 1,051,507 B | 1,051,507 B |
| Export p50/p95/p99 | 26 / 29 / 29 ms | 1.8 / 2.6 / 2.6 ms | 11 / 12 / ~12 ms |
| Export MB/sec | ~37 | ~518 | ~89 |
| Hydration p50/p95/p99 | 1.6 / 2.1 / 2.2 ms | 1.40 / 1.41 / 1.42 ms | 7.7 / 8.2 / ~8 ms |
| Hydration MB/sec | ~571 | ~714 | ~127 |
| Round-trip | 29 ms | 3.7 ms | (included in suite) |
| Memory | `number[]` × payload | growable `Uint8Array`; restore without extra clone | Chrome heap API quantized |

**Incremental snapshots:** export always serializes the full database. A 1% row change still pays 100% export cost. Delta/incremental snapshots are a future opportunity, not implemented (architecture is full-state SQLM).

Fidelity: `snapshot/fidelity/200` plus `tests/contract/snapshots` and determinism snapshot tests pass.

## Compatibility

- Full SQLite compatibility suite: **`bun run test:sqlite-compat`**
- Gate: **OK** (oracle 3.51.0)
- Tests: **727 pass, 0 fail** (contract + fuzz + harness)

## Remaining bottlenecks

1. **Insert / update row construction** — still Map-backed rows, affinity, index maintenance, trigger/FK checks. Uniqueness uses `IndexStore` / autoindexes. Native insert parity needs a columnar/row-representation rewrite.
2. **BEGIN / SAVEPOINT** — copy-on-write: snapshots share frozen tables and clone on first write. Cheap on `hotspot/tx-begin/1000` (~0.03 ms). First write in a large TX still copies that table.
3. **Row representation** — `Map<string, SqlValue>` + per-query `Cell[]` still dominate full scans and snapshot hydrate memory amplification (~8–10× heap vs payload)
4. **FTS MATCH** still scans virtual-table rows (inverted index exists but is not the MATCH cursor path). Acceptable for small corpora; do not prioritize until product-critical.
5. **RIGHT/FULL joins** still nested-loop (INNER/LEFT equality joins use index probe or hash-join fallback)
6. **1M-row / 100 MB snapshot** cases are Bun/desktop-only; not claimed on throttled mobile

## Local-first guidance (JSON / FTS)

- **`json_extract` / `->>` / `json_set`** are cheap point ops (~tens of µs). Prefer them over expanding JSON into rows.
- **`json_each`** is intentionally expensive: it materializes relational rows from nested JSON. Avoid in hot paths. Prefer normalizing frequently queried fields, generated/materialized columns, or indexed extracts; reserve `json_each` for genuinely dynamic traversal.
- **FTS**: benchmark scaling is roughly linear in corpus size while MATCH filters after a virtual-table scan. Realistic search terms and result cardinality matter more than micro-optimizing FTS until it is on a critical path.

## Benchmark methodology notes

- Reports include **perOp** (`mean / opsPerSample`) so multi-op samples are comparable.
- When `iterations < 5`, p95/p99 are shown as **n/a** (mean marked with `~`) — do not treat those as percentile estimates.
- Stateful write benches use **`isolateIterations`** (fresh engine + setup per sample) so rows do not accumulate across iterations.
- Workload-c reports per-query timings (`userMs`, `projectMs`, `joinMs`) plus separate email-lookup and join-only cases.

## JS / SQLite engine comparison

Fair core micros against other engines (not a full SQLite-compatibility claim for AlaSQL):

```bash
bun run benchmark:compare          # both tracks, all available engines
bun run benchmark:compare-js       # sqlite-mem vs AlaSQL (dialect-safe)
bun run benchmark:compare-sqlite   # sqlite-mem vs bun:sqlite / sql.js / wa-sqlite
# → benchmarks/results/compare-js.json (+ .html)
```

### Dual tracks

| Track | Specs | Engines | Schema |
| --- | --- | --- | --- |
| **JS dialect** | `compare/js/*` | sqlite-mem, AlaSQL | `INT` / `STRING` (no INTEGER PRIMARY KEY) |
| **SQLite** | `compare/sqlite/*` | sqlite-mem, bun-sqlite, sql.js, wa-sqlite | `INTEGER PRIMARY KEY` + index on join key |

Ops (sizes 100 / 1000): id lookup, N inserts, equality join, prepared id executes.

Caveats:

- AlaSQL is **not** SQLite; the JS track uses a conservative dialect so both engines run the same SQL.
- On the JS track, sqlite-mem does **not** use its rowid PK fast path — see the SQLite track (or `micro/pk-lookup`) for peak point-lookup claims.
- “Prepared” for AlaSQL means `alasql.compile`; for sql.js / wa-sqlite it means real prepared statements (wa-sqlite’s API is async under the harness).
- In-memory AlaSQL transactions are best-effort; do not treat TX insert wins as durability batching.
- `alasql`, `sql.js`, and `wa-sqlite` are **devDependencies** only; the published package stays zero-runtime-deps. Missing packages are soft-skipped with a warning.

Stop condition: mobile interactive and 1 MB snapshot targets met without a bytecode VM or format break.
