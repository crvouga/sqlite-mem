# Proof status — drop-in evidence

**As of:** 2026-08-20 (Wave 1–5 dialect proof pass). Full argument lives in [DROP-IN-CONTRACT.md](DROP-IN-CONTRACT.md) and [GAP-ANALYSIS.md](GAP-ANALYSIS.md).

## What is proven now

| Mechanism | Evidence |
| --- | --- |
| Differential SQL vs `bun:sqlite` | `bun run test:sqlite-compat` |
| `sqlite_master.sql` text | Stored + normalized; dump compares `sql:…`; `tests/contract/schema/master-sql.test.ts` |
| `?NNN` binds | `tests/contract/parameters/numbered.test.ts` |
| `NOT IN (SELECT)` NULL trap | `tests/contract/null/not-in-select.test.ts` |
| Multi-statement `exec` counters | same file + `api/freeze.test.ts` |
| Bind rejection matrix | `tests/contract/parameters/bind-rejection.test.ts` |
| Error depth (CHECK UPDATE, generated, MATCH) | `tests/contract/errors/depth.test.ts` |
| Scalar / empty IN subquery edges | `tests/contract/subqueries/edges.test.ts` |
| UPSERT / UPDATE FROM / windows / JSON / date / collate / FK+trigger | `tests/contract/*/thin-gaps` + related |
| Mixed DDL+DML+txn+PRAGMA simulation | `tests/fuzz/mixed-stateful.test.ts` + `transactions/stateful.test.ts` |
| Smoke baseline emptied | `compat/smoke-baseline.json` (`ids: []`) — former smoke IDs promoted |
| Affinity / bind / malformed fuzz + determinism properties | `tests/fuzz/affinity-binds.test.ts` |
| Canaries (suite can fail) | `bun run test:canaries` |
| Skip register | `bun run scripts/check-skip-register.ts` (wired into `test:sqlite-compat`) |
| Browser SQL smoke | `bun run test:browser-sql` (12 fixtures vs recorded oracle) |
| Purity gate | `verify-package` bans WASM / `eval` / `new Function` / SAB / Atomics |
| Divergences doc | Auto-generated [DIVERGENCES.md](../DIVERGENCES.md) |

## What is NOT proven (still blockers for WASM / API drop-in)

- On-disk `.sqlite` read/write (§35)
- JS UDFs / custom collations (§34)
- Adapter exports + upstream suites (§54)
- Full contract suite in all browsers / workers (§49) — smoke only
- `sqllogictest`, Stryker mutation score, grammar production coverage
- Sync-engine E2E (§56)

Honest product claim: **SQL dialect drop-in** for the native sync API — **not** a swap-in for `sql.js` / `sqlite-wasm`.
