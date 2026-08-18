# sqlite-mem

Pure TypeScript, completely in-memory SQLite implementation aiming for **full SQLite3 SQL dialect parity** (same statements → same results).

- Runs in modern browsers and Node.js / Bun
- **Zero** WASM, native bindings, workers, or filesystem dependencies
- Entire database stored in memory
- **Synchronous** ESM-only API (no Promises, no `require`)
- **Verified against SQLite 3.51.0** (`bun:sqlite`) via differential contracts + fail-closed gate
- Intentional differences: deterministic `random()` / `'now'` by default, and a custom snapshot format (not `.sqlite` files)

See [COMPATIBILITY.md](COMPATIBILITY.md) for the matrix and [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) for the audit report. Agents contributing to this repo: start with [AGENTS.md](AGENTS.md).

## Documentation

| Doc | For |
| --- | --- |
| [README.md](README.md) | Install, API, pitfalls (this file) |
| [AGENTS.md](AGENTS.md) | Architecture, how to change code, test/compat gates |
| [COMPATIBILITY.md](COMPATIBILITY.md) | Feature matrix + verify commands |
| [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) | Audit evidence |
| [docs/SECRETS.md](docs/SECRETS.md) | npm / CI publish setup |
| [benchmarks/PERFORMANCE.md](benchmarks/PERFORMANCE.md) | Performance notes |

## Install

```bash
bun add @crvouga/sqlite-mem
# or
npm install @crvouga/sqlite-mem
```

Requires Node.js ≥ 20 or Bun ≥ 1.1. The published package is **ESM only** (`import` from `@crvouga/sqlite-mem`).

## Usage

```ts
import { Database } from "@crvouga/sqlite-mem";

const db = new Database();

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  )
`);

db.exec(`INSERT INTO users (name) VALUES (?)`, ["Alice"]);

const users = db.query<{ id: number; name: string }>(`SELECT * FROM users`);
console.log(users);

const snap = db.snapshot();
const db2 = new Database();
db2.restore(snap);
```

All methods are **synchronous** — do not `await` them. Browser and Node/Bun share the same in-memory JS surface (no filesystem; `ATTACH` opens a new empty in-memory schema, not a file).

## API

```ts
import { Database, SqliteError } from "@crvouga/sqlite-mem";

interface DatabaseOptions {
  seed?: number | bigint;           // default 1 — PRNG for random() / randomblob()
  now?: Date | (() => Date);        // default 2000-01-01T00:00:00.000Z
  prng?: Prng;                      // optional; overrides seed
}

interface Database {
  constructor(options?: DatabaseOptions);
  exec(sql: string, params?: BindValue[]): void;
  query<T = QueryRow>(sql: string, params?: BindValue[]): T[];
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): T;
  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
  close(): void;
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

interface Statement {
  bind(...params: BindValue[]): Statement;
  run(...params: BindValue[]): RunResult;
  all<T = QueryRow>(...params: BindValue[]): T[];
  get<T = QueryRow>(...params: BindValue[]): T | undefined;
  result(...params: BindValue[]): ResultSet; // includes columns when zero rows
}

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface ResultSet {
  columns: string[];
  rows: QueryRow[];
  values?: QueryValue[][];
  changes: number;
  lastInsertRowid: number | bigint;
}

class SqliteError extends Error {
  readonly category: ErrorCategory; // syntax, no_such_table, constraint_unique, misuse, …
  readonly sqliteCode?: string;
}
```

Stick to `Database`, `Statement`, and `SqliteError` for application code. The package also exports lower-level helpers (`parse`, `tokenize`, `evalExpr`, snapshot codec pieces, `SqlValue` utilities) for advanced use.

### Method semantics

| Method | Behavior |
| --- | --- |
| `exec(sql, params?)` | Runs all semicolon-separated statements; **discards** row results (`void`). Read `db.changes` / `db.lastInsertRowid` afterward if needed. |
| `query(sql, params?)` | Same parse/run; returns rows of the **last** statement that has columns. Earlier SELECTs in a multi-statement script are dropped. |
| `prepare(sql)` | Parses immediately; AST is reused. `run` / `all` / `get` / `result` with args override prior `bind()`. |
| `transaction(fn)` | If idle: `BEGIN` → `fn()` → `COMMIT`, or `ROLLBACK` + rethrow. If already in a transaction: nested savepoint. Nested SQL `BEGIN` still errors. |
| `snapshot` / `restore` | Custom binary format (see below). |
| `close()` | Idempotent; rolls back an open transaction; further ops throw `misuse`. |

SQL `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE` are first-class. Empty SQL throws `misuse` (`empty statement`).

### Parameter binding

Supported styles: `?`, `?NNN`, `:name`, `@name`, `$name`.

- The JS API takes a **positional array** (or rest args) only — there is **no** `bind({ name: value })`.
- Named parameters occupy slots in **first-occurrence order**; repeated names share one slot.
- Prefixes are part of the name: `@x`, `$x`, and `:x` are **three different** parameters.
- Names are lowercased for lookup (`:Left` ≡ `:left`).
- Bindable: `null`, `string`, finite `number`, `bigint`, `boolean` → `0`/`1`, `Uint8Array` / `ArrayBuffer`.
- Rejected: `undefined`, `Date`, plain objects, `NaN` / `Infinity`.

```ts
db.query(`SELECT ? AS a, :name AS b`, [1, "Alice"]);
db.prepare(`SELECT @id AS id`).bind(42).get();
```

### Returned JavaScript types

| SQL storage | JS value | Notes |
| --- | --- | --- |
| NULL | `null` | Never `undefined` |
| INTEGER | `number` or `bigint` | `bigint` when outside `Number.MAX_SAFE_INTEGER` |
| REAL | `number` | Including integer-valued reals (`1.0` → `1`); use SQL `typeof()` to distinguish from INTEGER |
| TEXT | `string` | JSON subtype unwrapped to string |
| BLOB | `Uint8Array` | |

Duplicate column names collapse in row objects (last write wins). Use `stmt.result().values` for positional cells.

### Snapshots

- Format magic `SQLM` — **not** a portable `.sqlite` file and not loadable by the SQLite CLI.
- Round-trips ordinary tables, views, indexes, change counters, PRNG state, and clock.
- **Not** encoded: triggers, ATTACH’d schemas, virtual tables (FTS / RTREE / …), `userVersion`.
- Cannot `restore()` while a transaction is open.
- `restore()` replaces `now` with a fixed clock from the snapshot (a live `() => Date` is overwritten).
- Equivalent databases produce byte-identical snapshots (schema/rows sorted).

## Determinism

The engine is deterministic by default. Invariants:

| Source | Default | Override / notes |
| --- | --- | --- |
| `random()` / `randomblob()` | Seeded xorshift64* (`seed: 1`) | `new Database({ seed })` or `{ prng }` |
| `date('now')` / friends | Fixed `2000-01-01T00:00:00.000Z` | `new Database({ now: Date \| (() => Date) })` |
| Table scans | Rowid order | Same order after `snapshot`/`restore` |
| Snapshots | Sorted schema/rows + PRNG state + clock | Restored into PRNG and `now` |
| Transactions | PRNG rolls back with `ROLLBACK`/`SAVEPOINT` | Matches data rollback |
| Numbers | IEEE `-0` canonicalized to `+0` | Bind, affinity, and arithmetic |

Fuzz / property tests use a fixed seed (`0x5a17e0e1`) and print it on failure:

```bash
bun test tests/fuzz
SQLITE_MEM_FUZZ_SEED=12345 bun test tests/fuzz
SQLITE_MEM_FUZZ_SEED=12345 SQLITE_MEM_FUZZ_PATH='0:1' bun test tests/fuzz  # exact replay
```

## Compatibility notes for integrators

Goal: drop-in SQL behavior vs SQLite **3.51.0**. Full matrix: [COMPATIBILITY.md](COMPATIBILITY.md).

**Intentional differences:** custom `SQLM` snapshots; seeded `random()` / fixed `'now'`; no C API / on-disk DB / VFS.

**Know these thin or partial areas** (do not assume full oracle fidelity):

- FTS3/4/5 — largely implemented; shadow-table change counters intentionally diverge; some edges partial
- `EXPLAIN` / `EXPLAIN QUERY PLAN` — stub shapes, not real bytecode
- `INDEXED BY` / `NOT INDEXED` — parsed and discarded
- Unknown `PRAGMA` succeeds with an empty result (SQLite-like); storage/journal/WAL pragmas N/A or no-op

## Common pitfalls

1. **Do not `await`** — the API is sync.
2. **No named-object binds** — use positional arrays in declaration order.
3. **Multi-statement `query`** returns only the last result set with columns.
4. **`exec` returns `void`** — use `db.changes` / `stmt.run()` for counters.
5. **`'now'` is not wall-clock** unless you pass `{ now: () => new Date() }`. Default is year 2000.
6. **`random()` is seeded**, not OS entropy; snapshots restore the PRNG.
7. **Snapshots are not `.sqlite` files** and do not round-trip FTS / triggers / ATTACH.
8. **No better-sqlite3 extras** — no `iterate`, `pluck`/`raw`, `safeIntegers` option, `pragma()` helper, `loadExtension`, or SQLite-file `serialize()`.
9. **Do not bind `Date` objects** — store unixepoch integers or ISO text.
10. **Do not use `Number.isInteger` for SQL REAL vs INTEGER** — use SQL `typeof()`.

Working examples beyond this README: `tests/contract/api/`, `tests/contract/parameters/`, `tests/browser/run.ts`.

## Development

Requires [Bun](https://bun.sh). For architecture, change checklists, and how to add contract tests, see **[AGENTS.md](AGENTS.md)**.

Parity is proven only by differential contracts against real SQLite (`bun:sqlite`). Isolated internal unit tests are not SQLite compatibility proof.

```bash
bun install
bun run ci:local             # same gates as GitHub Actions CI (except publish)
bun run check                # format + lint + typecheck + sqlite-compat suite
bun run format               # write Biome formatting
bun run lint                 # Biome lint
bun run typecheck
bun run test:sqlite-compat   # requirements + inventory gate + differential suite
bun test                     # contract + fuzz + harness
bun run build
bun run test:browser         # Playwright smoke (Chrome/Firefox/Safari)
```

See [COMPATIBILITY.md](./COMPATIBILITY.md).

## Releasing

Publishing is fully automated. You never bump `version` or run `npm publish` by hand.

### How a release happens

1. Push or merge to `main` with [Conventional Commits](https://www.conventionalcommits.org/).
2. CI runs commitlint, format/lint/typecheck, build, package verification, tests, browser smoke, and benchmarks.
3. If every gate is green, [semantic-release](https://semantic-release.gitbook.io/) analyzes commits since the last git tag, bumps semver, publishes to npm, and creates a GitHub Release.

| Commit | Version bump |
| --- | --- |
| `fix: …` | patch (`0.1.0` → `0.1.1`) |
| `feat: …` | minor (`0.1.0` → `0.2.0`) |
| `feat!: …` or `BREAKING CHANGE:` footer | major (`0.2.0` → `1.0.0`) |
| `docs:`, `chore:`, `refactor:`, `test:`, … | no release |

Examples:

```text
feat: add window function support
fix: handle NULL in UNIQUE constraints
feat!: rename snapshot() return type

chore: tweak CI timeouts
docs: clarify determinism table
```

PR titles must also follow Conventional Commits (enforced in CI). Prefer squash merges with a conventional title.

Local checks:

```bash
bun run ci:local             # commitlint + quality + tests + browser + benchmarks
# dry-run needs a GitHub token for API calls; CI publish uses Trusted Publishing (no NPM_TOKEN)
bun run release:dry-run
```

`package.json` version is `0.0.0-development` on purpose — **git tags** (`v0.1.0`, …) are the source of truth.

### One-time setup (maintainers)

Do this once so CI can publish. Full checklist: **[docs/SECRETS.md](./docs/SECRETS.md)**.

1. **Create the package on npm (once), then Trusted Publishing.** If https://www.npmjs.com/package/@crvouga/sqlite-mem 404s:

   ```bash
   npm login --auth-type=web
   bun run npm:seed -- --yes
   ```

   npm does not email a publish code — complete 2FA in the browser or authenticator app.

   Then on [package Access](https://www.npmjs.com/package/@crvouga/sqlite-mem/access) → Trusted Publisher → GitHub Actions (`crvouga/sqlite-mem`, workflow `ci.yml`). Do **not** create an Automation / granular access token for CI.
2. Confirm GitHub Actions is enabled and can create releases (default `GITHUB_TOKEN` is enough with this workflow’s permissions). No `NPM_TOKEN` repo secret.
3. Ensure the baseline tag exists and is pushed: `v0.1.0` (semver continues from there; the next `feat` publishes `0.2.0`).

Validate the checklist anytime with `bun run secrets:doctor`.

After that, every green push to `main` with releasable commits updates npm automatically.

## License

MIT
