# Differential parity gaps

Checklist of where sqlite-mem’s **drop-in vs SQLite 3.51.0** claim is not yet proven by the differential suite. Update this file after each work session: tick items that land a named contract test, or move a **LIKELY DIVERGENCE** to [COMPATIBILITY.md](../COMPATIBILITY.md) if it is an intentional limitation.

Parity is proven **only** by `parity` / `execParity` / `errorParity` / `sequenceParity` / `matrixBoth` against `bun:sqlite`. Isolated `new Database()` tests do not count.

Do not mark a [COMPATIBILITY.md](../COMPATIBILITY.md) row **VERIFIED** from this audit alone. Several current VERIFIED rows are page-level seeds, not construct-level proof.

## Legend

| Label | Meaning |
| --- | --- |
| **COVERED** | Differential happy path **and** meaningful edges vs oracle |
| **THIN** | Some differential tests; important real-app forms missing |
| **GAP** | No differential test |
| **ISOLATED** | sqlite-mem-only unit test; not oracle proof |
| **LIKELY DIVERGENCE** | Implementation suggests mismatch; add a failing contract before fixing |
| **P0** | Likely in application SQL |
| **P1** | Less common |
| **P2** | Exotic, or already documented as partial |

Checked items (`[x]`) are already differentially covered. Unchecked items are work remaining.

## Method

[COMPATIBILITY.md](../COMPATIBILITY.md) and `compat/coverage.json` mark large areas **VERIFIED** via page-level `SOURCE_SEED` in [`scripts/sqlite-requirements.ts`](../scripts/sqlite-requirements.ts) (for example `lang_insert.html` → `tests/contract/insert/` + `tests/contract/upsert/`). That is **directory existence**, not construct-level coverage.

Current matrix (`compat/coverage.json`): 1901 SQL_BEHAVIOR requirements → 1372 VERIFIED / 351 PARTIALLY_VERIFIED / 178 UNSUPPORTED. UNSUPPORTED is mostly unmapped sqlite.org pages (`optoverview.html`, `uri.html`, `vtab.html`, …), not a construct checklist.

**LIKELY DIVERGENCE** items are hypotheses (missing or approximate implementation). Probe with a failing contract first, then fix or document.

## Next probes (P0 LIKELY DIVERGENCE)

Work these first: failing differential contract, then fix or document.

1. SQL `TRUE` / `FALSE` literals
2. `weekday N` date modifier
3. Comparison affinity (`1 = '1'`)
4. `generate_series` vs oracle
5. `REGEXP`
6. `NOT IN (SELECT …)` NULL trap

---

## P0 — app-code areas

### 1. UPSERT — THIN

Evidence: [`tests/contract/upsert/`](../tests/contract/upsert/), [`tests/fuzz/upsert.test.ts`](../tests/fuzz/upsert.test.ts)

- [x] `ON CONFLICT(pk) DO UPDATE SET … = excluded.…` and current-row arithmetic
- [x] `DO NOTHING` with explicit target (PK + composite UNIQUE)
- [x] Composite conflict target; secondary UNIQUE still enforced during PK upsert
- [x] Partial unique index: `ON CONFLICT DO NOTHING` and `ON CONFLICT(email) WHERE … DO UPDATE`
- [x] Expression unique index `ON CONFLICT(lower(email))`
- [ ] UPSERT + `RETURNING`
- [ ] `DO UPDATE … WHERE` (skip update if predicate false)
- [ ] `INSERT … SELECT … ON CONFLICT`
- [ ] `ON CONFLICT` with no target on a table that has multiple unique constraints
- [ ] `INSERT OR IGNORE` / `OR REPLACE` vs UPSERT on the same table
- [ ] UPSERT against INTEGER PRIMARY KEY AUTOINCREMENT + `last_insert_rowid`
- [ ] `excluded.*` star; UPSERT + WITHOUT ROWID; `ON CONFLICT(rowid)`

### 2. CTEs — THIN

Evidence: [`tests/contract/cte/`](../tests/contract/cte/), [`tests/contract/recursive-cte/`](../tests/contract/recursive-cte/), [`tests/fuzz/cte.test.ts`](../tests/fuzz/cte.test.ts)

- [x] Non-recursive WITH, multiple CTEs, CTE shadowing a table
- [x] Recursive UNION ALL sequences; UNION cycle dedup; >1000 steps
- [ ] **LIKELY DIVERGENCE:** `MATERIALIZED` / `NOT MATERIALIZED` parsed and discarded ([`src/parser/parser.ts`](../src/parser/parser.ts) `parseWithClause`; not on `Cte` AST)
- [ ] `WITH` on `INSERT` / `UPDATE` / `DELETE` (no matches in contract suite)
- [ ] Recursive CTE `LIMIT` / `ORDER BY` (SQLite search-limit)
- [ ] Nested WITH; CTE referenced from a view; VALUES + recursive mix
- [ ] Mixed recursive + non-recursive CTEs; `INSERT INTO t SELECT * FROM cte`; column-count mismatch `errorParity`

### 3. Window functions — THIN

Evidence: [`tests/contract/window-functions/`](../tests/contract/window-functions/), [`tests/fuzz/windows.test.ts`](../tests/fuzz/windows.test.ts)

- [x] `row_number` / `rank` / `dense_rank` / `lag` / `lead` / running `sum`
- [x] Named `WINDOW`; ROWS `n PRECEDING/FOLLOWING`; default peer frame
- [x] `EXCLUDE NO OTHERS|CURRENT ROW|GROUP|TIES` (ROWS + one RANGE)
- [x] `ntile` / `cume_dist` / `percent_rank` — one query in [`tests/contract/functions/scope3-builtins.test.ts`](../tests/contract/functions/scope3-builtins.test.ts)
- [ ] `GROUPS` frames (AST has the type; no contract)
- [ ] `RANGE BETWEEN n PRECEDING AND m FOLLOWING` (numeric offsets)
- [ ] Window `FILTER (WHERE …)`
- [ ] `lag`/`lead` with offset + default; `nth_value` beyond the one `first/last/nth` test
- [ ] `IGNORE NULLS` / `RESPECT NULLS` (SQLite 3.51 window option)
- [ ] Empty `OVER ()`; window in WHERE (must fail); `BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING`

### 4. JSON1 — mostly COVERED, a few holes

Evidence: [`tests/contract/json/`](../tests/contract/json/), [`tests/fuzz/json.test.ts`](../tests/fuzz/json.test.ts)

- [x] `json` / extract / set/insert/replace/remove/patch / quote / type / valid / error_position / pretty
- [x] `->` / `->>`; jsonb encode + mutate; `json_each` / `json_tree`; `json_group_array/object`
- [ ] `json_array_insert` / `jsonb_array_insert`: conditional differential **plus ISOLATED** memory-only tests in [`tests/contract/json/modify.test.ts`](../tests/contract/json/modify.test.ts)
- [ ] `json_group_array` `ORDER BY` / `FILTER`
- [ ] `json_valid` second argument (flags); `json_pretty` indent
- [ ] SQL `NULL` vs JSON `null` in `json_set` / `json_object`
- [ ] `json_remove` multiple paths; `json_set` multiple path/value pairs; `jsonb_replace` / `jsonb_group_object`
- [ ] `json_each`/`json_tree` on SQL NULL document

### 5. Date/time + modifiers — THIN / LIKELY DIVERGENCE

Evidence: [`tests/contract/date-time/`](../tests/contract/date-time/), [`src/functions/datetime.ts`](../src/functions/datetime.ts)

- [x] `date`/`time`/`datetime` with `+1 day`, `start of month`, `unixepoch` on `datetime(0,…)`
- [x] `strftime` `%Y-%m-%d` / `%H:%M:%S`
- [ ] **LIKELY DIVERGENCE:** `weekday N` — not implemented (`applyModifier` returns null)
- [ ] **LIKELY DIVERGENCE:** `subsec` / `auto` / `ceiling` / `floor` modifiers — absent
- [ ] `start of year` / `start of day` implemented, untested
- [ ] **LIKELY DIVERGENCE:** `timediff` uses 365.2425-day years — probably not oracle-identical
- [ ] `julianday`; `unixepoch()`; `strftime('%s'|'%j'|'%W'|'%f')`; chained `unixepoch` + calendar mods
- [ ] `localtime`/`utc` are no-ops (intentional if documented; currently untested)
- [ ] Invalid dates (`2024-02-30`) NULL vs error; timezone offsets in input strings

### 6. LIKE / GLOB — THIN

Evidence: [`tests/contract/expressions/operators.test.ts`](../tests/contract/expressions/operators.test.ts), [`tests/contract/expressions/edges.test.ts`](../tests/contract/expressions/edges.test.ts)

- [x] LIKE case-insensitive ASCII; ESCAPE `!`; NOT LIKE; GLOB `*` `?` `[abc]` `[a-c]` `[^]`
- [ ] `NULL LIKE x`, `x LIKE NULL`, empty pattern, LIKE on BLOB
- [ ] Unicode case (`'ß' LIKE 'SS'`) — SQLite NOCASE is ASCII-only
- [ ] `PRAGMA case_sensitive_like` (unknown pragma currently returns empty)
- [ ] LIKE vs column `COLLATE BINARY` (LIKE ignores collation)
- [ ] **GAP / LIKELY DIVERGENCE:** `REGEXP` is a lexer keyword and an inventory name, but **not parsed** as an operator and has **no evaluator** in `src/`
- [ ] `ESCAPE ''` (SQLite error); multi-char ESCAPE; `NOT GLOB`

### 7. COLLATE NOCASE — THIN

Evidence: [`tests/contract/collate/`](../tests/contract/collate/)

- [x] `ORDER BY … COLLATE NOCASE`; `'a'='A' COLLATE NOCASE`; RTRIM; BINARY
- [x] UNIQUE index `COLLATE NOCASE`; column-declared COLLATE on `=` and `ORDER BY`
- [x] WITHOUT ROWID PK `COLLATE NOCASE`
- [ ] `CREATE TABLE t(x TEXT UNIQUE COLLATE NOCASE)` (constraint vs index)
- [ ] COLLATE on JOIN / `GROUP BY` / `BETWEEN` / CHECK / generated column
- [ ] RTRIM on UNIQUE; NOCASE on non-TEXT storage

### 8. Type affinity coercions — THIN

Evidence: [`tests/contract/types/`](../tests/contract/types/)

- [x] INSERT affinity for INTEGER/REAL/TEXT/BLOB/NUMERIC; CAST; mixed `ORDER BY` storage classes
- [x] STRICT tables (separate, COVERED)
- [ ] **Comparison affinity** (`1 = '1'`, `'1.0' = 1`, `WHERE int_col = '1'`) — high likelihood in app code
- [ ] INTEGER PRIMARY KEY `NULL` insert (rowid assign); `'1'` vs `1.0` into IPK
- [ ] Full type-name table (`VARCHAR`, `CLOB`, `FLOAT`, `BOOLEAN`, `DATE`)

### 9. IS / IS NOT — THIN

Evidence: [`tests/contract/null/semantics.test.ts`](../tests/contract/null/semantics.test.ts), [`tests/contract/expressions/distinct-from.test.ts`](../tests/contract/expressions/distinct-from.test.ts)

- [x] `IS NULL` / `IS NOT NULL`; `IS DISTINCT FROM` / `IS NOT DISTINCT FROM` (incl. `1` vs `1.0`)
- [ ] **LIKELY DIVERGENCE:** SQL `TRUE`/`FALSE` literals — **not in lexer** ([`src/lexer/tokenize.ts`](../src/lexer/tokenize.ts)); `SELECT TRUE` is likely `no_such_column` vs oracle `1`
- [ ] `IS TRUE` / `IS FALSE` / `IS NOT TRUE`
- [ ] postfix `ISNULL` / `NOTNULL`; `IS` with BLOBs
- [ ] `x IS y` / `x IS NOT y` for non-NULL values (`1 IS 1.0`, `'a' IS 'a'`) — SQLite NULL-safe equality

### 10. Generated columns — THIN + ISOLATED

Evidence: [`tests/contract/generated/basic.test.ts`](../tests/contract/generated/basic.test.ts)

- [x] STORED + VIRTUAL `SELECT` after insert of base columns
- [ ] ISOLATED: “cannot insert into generated” is `new Database()` only — needs `errorParity`
- [ ] UPDATE of generated; index on generated; generated as UNIQUE/PK
- [ ] `PRAGMA table_xinfo` `hidden` 2 vs 3 (code comments uncertainty)
- [ ] Generated referencing another generated; affinity of generated

### 11. Foreign keys + ON DELETE/UPDATE — mostly COVERED

Evidence: [`tests/contract/foreign-keys/`](../tests/contract/foreign-keys/)

- [x] Insert reject/accept; NULL child; default RESTRICT on parent DELETE
- [x] ON DELETE CASCADE / SET NULL / SET DEFAULT / RESTRICT
- [x] ON UPDATE CASCADE / SET NULL / SET DEFAULT / RESTRICT (TEXT + INTEGER PK)
- [x] Composite CASCADE; deferred INITIALLY DEFERRED/IMMEDIATE; `foreign_keys=OFF`
- [ ] Explicit `ON DELETE NO ACTION` vs RESTRICT (differs when DEFERRABLE)
- [ ] `MATCH SIMPLE|FULL`; `PRAGMA foreign_key_check` / `foreign_key_list`
- [ ] FK actions + triggers; parent REPLACE
- [ ] `ON DELETE SET DEFAULT` when the default parent row is missing (must fail)
- [ ] Combined `ON DELETE CASCADE ON UPDATE SET NULL`; FK referencing UNIQUE (not PK)

### 12. Partial indexes — mostly COVERED

Evidence: [`tests/contract/indexes/partial.test.ts`](../tests/contract/indexes/partial.test.ts)

- [x] Unique partial allows dups outside predicate; rejects inside; UPDATE into index; UPSERT WHERE; SELECT still correct
- [ ] Non-unique partial as lookup path with extra predicate
- [ ] `WHERE` with NULL / expression / collation; UPDATE that leaves the index

### 13. Expression indexes — mostly COVERED

Evidence: [`tests/contract/indexes/expression.test.ts`](../tests/contract/indexes/expression.test.ts)

- [x] `UNIQUE (lower(email))`; `json_extract`; `a+b`; ON CONFLICT on expression
- [ ] DESC / COLLATE in expression index; multi-column expressions; partial + expression together

---

## P0 — additional drop-in holes

Not in the original 13 app-code areas, but high likelihood of breaking a drop-in.

- [ ] **TRUE/FALSE literals** — LIKELY DIVERGENCE (see [IS / IS NOT](#9-is--is-not--thin))
- [ ] **`generate_series`** — ISOLATED only ([`tests/contract/table-valued/basic.test.ts`](../tests/contract/table-valued/basic.test.ts)); must be `parity` vs oracle
- [ ] **`MATCH` on non-FTS** — ISOLATED `unsupported` ([`tests/contract/errors/unsupported.test.ts`](../tests/contract/errors/unsupported.test.ts)); oracle category unknown
- [ ] **Bind / API garbage** — GAP: NaN/Infinity/`undefined`/too many/too few params; README claims rejection with no differential test
- [ ] **`-0` bind** — ISOLATED in [`tests/contract/determinism/basic.test.ts`](../tests/contract/determinism/basic.test.ts)
- [ ] **i64 / MAX_SAFE_INTEGER±1** — GAP; [`tests/contract/parameters/audit.test.ts`](../tests/contract/parameters/audit.test.ts) stays inside MAX_SAFE_INTEGER because bun:sqlite lacks `safeIntegers` (document as API difference; still need SQL-literal i64 tests)
- [ ] **rowid reuse after DELETE** on plain INTEGER PRIMARY KEY (AUTOINCREMENT non-reuse is covered)
- [ ] **`total_changes()`** asserted as `>= 2` not exact ([`tests/contract/functions/scope3-builtins.test.ts`](../tests/contract/functions/scope3-builtins.test.ts))
- [ ] **Conflict oracles** `OR ABORT` / `OR FAIL` / `OR ROLLBACK` — no contract
- [ ] **Triggers:** only AFTER INSERT + WHEN + DROP; missing BEFORE, `UPDATE OF`, INSTEAD OF views, `RAISE()`, `recursive_triggers`, `last_insert_rowid` across trigger inserts
- [ ] **PRAGMA surface:** only `foreign_keys`, `table_info`, `database_list`, `user_version`, unknown→empty. Missing `table_xinfo`, `index_list`/`index_info`, `foreign_key_list`, `schema_version`, `recursive_triggers`, `defer_foreign_keys`, `integrity_check`
- [ ] **RETURNING** on UPSERT; `RETURNING` excluded columns / `old`/`new` names
- [ ] **UPDATE … FROM** — one join; missing multi-match, LEFT FROM, correlated
- [ ] **`NOT IN (SELECT …)` NULL trap** — high-likelihood app SQL; only list-form `NOT IN` is tested
- [ ] **Comma joins** `FROM a, b WHERE …`; `USING` multi-column
- [ ] **`pragma_*` TVFs** (`pragma_table_info()`, `pragma_function_list()`) — not implemented; inventory ignores them
- [ ] Coverage hygiene: `uri.html` is UNSUPPORTED but mission says NOT APPLICABLE; `dbstat.html` UNSUPPORTED while the module exists; `fts5.html` / `json1.html` / `windowfunctions.html` are absent from the sqlite.org dump so they never appear in `coverage.json`

---

## Rest of SQL surface

| Area | Status | Evidence | Main gaps |
| --- | --- | --- | --- |
| SELECT / LIMIT / DISTINCT / ORDER BY NULLS | COVERED–THIN | select, limits, distinct, ordering | unordered SELECT stability; `LIMIT -1` |
| Joins INNER/LEFT/RIGHT/FULL/NATURAL/USING | COVERED | joins/* | CROSS JOIN alias; NATURAL FULL; USING multi-col |
| Subqueries scalar/IN/EXISTS/FROM | COVERED–THIN | subqueries/* | **`NOT IN (SELECT)` NULL trap**; multi-row scalar error; IN empty select |
| UNION/INTERSECT/EXCEPT | COVERED | unions/* | compound + WITH; INTERSECT ALL (if oracle) |
| Aggregates / GROUP BY / HAVING / FILTER | COVERED | aggregates, grouping | `GROUP BY ALL`; `string_agg` ORDER BY |
| INSERT/UPDATE/DELETE | COVERED–THIN | insert, update, delete | UPDATE of column being read is tested; DELETE LIMIT |
| Constraints UNIQUE/NOT NULL/CHECK/PK | COVERED | unique, constraints, check, primary-keys, errors | CHECK on UPDATE; named constraints |
| ALTER ADD/RENAME/DROP COLUMN | COVERED | alter-table/* | ADD PK/UNIQUE/CHECK (SQLite 3.51 still limited); DROP generated |
| Views | THIN | views/basic | INSTEAD OF; view WITH; INSERT into simple view |
| TEMP / ATTACH | COVERED–THIN | temp, attach | temp vs main same name; ATTACH file N/A |
| STRICT / WITHOUT ROWID | COVERED | schema/strict, without-rowid | |
| Indexes ordinary/prefix/autoindex | COVERED | indexes/* | DESC index sort; `INDEXED BY` is no-op (documented) |
| Parameters `?` `?NNN` `:n` `@n` `$n` | COVERED–THIN | parameters/* | too many/few; `?NNN` holes |
| Transactions / savepoints | COVERED | transactions, savepoints | `BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE` observable diff |
| ANALYZE / REINDEX / VACUUM | THIN | misc/analyze-vacuum | VACUUM INTO; REINDEX collation |
| EXPLAIN / INDEXED BY | PARTIAL (documented) | errors/unsupported | stub shapes |
| FTS3/4/5 | PARTIAL (documented) | fts/*, fuzz/fts | shadow counters; matchinfo formats; external content |
| RTREE / dbstat / bytecode | THIN–VERIFIED inventory | modules/scope3 | dbstat synthetic; bytecode empty cursor |
| Snapshots SQLM | ISOLATED-heavy | snapshots/basic | no unknown-version error test; no edge-value corpus |
| Lexer/parser identifiers/comments | COVERED–THIN | lexer, parser | very long names; embedded `""`; hex with odd digits |
| Core scalars | THIN | functions/* | inventory is name-presence only; printf flags; `soundex`; `likelihood` |

---

## Isolated tests that must not be treated as proof

Convert to `errorParity`/`parity` or label as engine-only:

- `generate_series` ([`tests/contract/table-valued/basic.test.ts`](../tests/contract/table-valued/basic.test.ts))
- generated-column insert error ([`tests/contract/generated/basic.test.ts`](../tests/contract/generated/basic.test.ts))
- MATCH non-FTS ([`tests/contract/errors/unsupported.test.ts`](../tests/contract/errors/unsupported.test.ts))
- `json_array_insert` memory-only block ([`tests/contract/json/modify.test.ts`](../tests/contract/json/modify.test.ts))
- `-0` bind, CURRENT_DATE clock, snapshot restore ([`tests/contract/determinism/basic.test.ts`](../tests/contract/determinism/basic.test.ts), [`tests/contract/api/basic.test.ts`](../tests/contract/api/basic.test.ts), [`tests/contract/snapshots/basic.test.ts`](../tests/contract/snapshots/basic.test.ts))
- `load_extension` unauthorized ([`tests/contract/functions/inventory.test.ts`](../tests/contract/functions/inventory.test.ts))

---

## Documented intentional differences (do not “fix”)

Keep these listed rather than treating them as parity bugs:

- Custom SQLM snapshots (not on-disk `.sqlite` files)
- Seeded `random()` / fixed `'now'` by default
- No C API / on-disk DB / VFS
- EXPLAIN stubs; INDEXED BY no-op
- Unknown PRAGMA returns empty result
- FTS shadow-table `changes()` divergence
- BigInt vs bun:sqlite without `safeIntegers`
