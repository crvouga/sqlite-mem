# Proof status — drop-in evidence

**As of:** 2026-08-20 (incremental). Full argument lives in [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md) and [GAP-ANALYSIS.md](GAP-ANALYSIS.md).

## What is proven now

| Mechanism | Evidence |
| --- | --- |
| Differential SQL vs `bun:sqlite` | `bun run test:sqlite-compat` (~1639 tests) |
| `sqlite_master.sql` text | Stored + normalized; dump compares `sql:…`; `tests/contract/schema/master-sql.test.ts` |
| `?NNN` binds | `tests/contract/parameters/numbered.test.ts` |
| `NOT IN (SELECT)` NULL trap | `tests/contract/null/not-in-select.test.ts` |
| Multi-statement `exec` counters | same file + `api/freeze.test.ts` |
| Canaries (suite can fail) | `bun run test:canaries` — 6/6 killed |
| Skip register | `bun run scripts/check-skip-register.ts` (wired into `test:sqlite-compat`) |
| Browser SQL smoke | `bun run test:browser-sql` (8 fixtures vs recorded oracle) |
| Purity gate | `verify-package` bans WASM / `eval` / `new Function` / SAB / Atomics |
| Divergences doc | Auto-generated [DIVERGENCES.md](../DIVERGENCES.md) |

## What is NOT proven (still blockers for WASM drop-in)

- On-disk `.sqlite` read/write (§35)
- JS UDFs / custom collations (§34)
- Adapter exports + upstream suites (§54)
- Full contract suite in all browsers / workers (§49)
- `sqllogictest`, Stryker mutation score, grammar production coverage
- Sync-engine E2E (§56)

Honest product claim: **SQL dialect drop-in** for the native sync API — **not** a swap-in for `sql.js` / `sqlite-wasm`.
