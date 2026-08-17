# Performance targets

Targets were set **after** measuring the unoptimized baseline on 2026-08-17, not invented beforehand.

## Target hardware / runtime

- Low-end mobile browser proxy: Chromium 151 + Playwright `Moto G4` + **4× CPU throttle**
- Interactive local-first DB: schema with users/projects/tasks, **100–1000 rows** hot working set
- Snapshots: **~1 MB** hydrate/export as the critical mobile path (larger sizes are Bun/desktop)

## Query latency (mobile profile, sqlite-mem)

| Workload | Metric | Baseline p95 | Target p95 | Status |
| --- | --- | --- | --- | --- |
| PK lookup, 1000 rows (20 lookups) | p95 | 34 ms | < 2 ms | PASS (0.47 ms) |
| Unique index lookup, 1000 rows | p95 | ~34 ms | < 2 ms | PASS (0.60 ms) |
| Prepared 1000 PK executes | p95 | 1578 ms | < 50 ms | PASS (9.4 ms) |
| Local-first CRUD loop ×50 | p95 | 56 ms | < 50 ms | PASS (28 ms) |
| Indexed app queries (200 users) | p95 | 356 ms | < 50 ms | PASS (12 ms) |
| Indexed join small⋈large 1000 | p95 | 39 ms | < 5 ms | PASS (0.68 ms) |
| Schema + first query | p95 | 1.3 ms | < 5 ms | PASS (1.65 ms) |

## Throughput (mobile)

| Operation | Baseline | Target | Status |
| --- | --- | --- | --- |
| Point lookups/sec (PK, 1000 rows) | ~600 | > 20,000 | PASS (~86k) |
| Prepared executes/sec | ~640 | > 20,000 | PASS (~114k) |
| Inserts/sec (1000 in a transaction) | ~1,100 | ≥ baseline (insert path not rewritten) | PASS (~1,090) |

## Snapshots (1 MB payload DB, mobile)

| Metric | Baseline | Target | Status |
| --- | --- | --- | --- |
| Export p95 | 100 ms | < 30 ms | PASS (12 ms) |
| Hydrate p95 | 7.4 ms | < 20 ms | PASS (8.2 ms) |
| Export MB/sec | ~10 | > 30 | PASS (~89) |
| Hydrate MB/sec | ~143 | > 50 | PASS (~127) |
| Format | SQLM v2 unchanged | no fidelity loss | PASS |

## Bundle

| Metric | Baseline | Target | Status |
| --- | --- | --- | --- |
| `dist/index.js` uncompressed | 383 KB | no large new deps | PASS (395 KB) |
| gzip | 76 KB | < 100 KB | PASS (79 KB) |
| brotli | 63 KB | < 90 KB | PASS (65 KB) |

## Memory

Chrome `performance.memory` on this profile is quantized (~10 MB) and is not a reliable peak gauge. Bun heap deltas for 1 MB snapshot export stay on the order of a few MB after the growable `Uint8Array` writer (previously a `number[]` byte builder). Target: **no multi-copy `number[]` snapshot buffer**. PASS.

Hydration adopts decoded state (no extra `DatabaseState.clone()`). Target: **peak amplification from an extra full clone on restore = removed**. PASS.

## How to re-measure

```bash
bun run benchmark          # Bun, default tier
bun run benchmark:ci       # small suite + 2.5× p95 gate vs committed baseline
bun run benchmark:browser  # Chromium desktop + throttled Moto G4
bun run benchmark:bun      # full tier + bun:sqlite comparison
bun run benchmark:bundle   # dist sizes
```
