# sqlite-mem

Pure TypeScript, completely in-memory SQLite implementation aiming for **full SQLite3 SQL dialect parity** (same statements → same results).

- Runs in modern browsers and Node.js / Bun
- **Zero** WASM, native bindings, workers, or filesystem dependencies
- Entire database stored in memory
- **Verified against SQLite 3.51.0** (`bun:sqlite`) via differential contracts + fail-closed gate
- Intentional differences: deterministic `random()` / `'now'` by default, and a custom snapshot format (not `.sqlite` files)

See [COMPATIBILITY.md](COMPATIBILITY.md) for the matrix and [COMPATIBILITY-AUDIT.md](COMPATIBILITY-AUDIT.md) for the audit report.

## Install

```bash
bun add sqlite-mem
# or
npm install sqlite-mem
```

## Usage

```ts
import { Database } from "sqlite-mem";

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

## API

```ts
interface Database {
  // seed default 1; now default 2000-01-01T00:00:00.000Z
  constructor(options?: { seed?: number | bigint; now?: Date | (() => Date) });
  exec(sql: string, params?: unknown[]): void;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): T;
  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
  close(): void;
}

interface Statement {
  bind(...params: unknown[]): Statement;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
}
```

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

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run check                # format + lint + typecheck + sqlite-compat suite
bun run format               # write Biome formatting
bun run lint                 # Biome lint
bun run typecheck
bun run test:sqlite-compat   # requirements + inventory gate + differential suite
bun test                     # contract + fuzz + harness
bun run build
bun run test:browser         # Playwright smoke (Chrome/Firefox/Safari)
```

Contract tests compare the pure TypeScript engine against real SQLite (`bun:sqlite`). See [COMPATIBILITY.md](./COMPATIBILITY.md).

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
bunx commitlint --last --verbose
bun run build && bun run verify-package
# dry-run needs GITHUB_TOKEN + NPM_TOKEN (or CI); does not publish
bun run release:dry-run
```

`package.json` version is `0.0.0-development` on purpose — **git tags** (`v0.1.0`, …) are the source of truth.

### One-time setup (maintainers)

Do this once so CI can publish:

1. **npm credentials** (pick one):
   - **Trusted Publishing (recommended):** on [npmjs.com](https://www.npmjs.com/) → package `sqlite-mem` → Settings → Trusted Publisher → GitHub Actions (`crvouga/sqlite-mem`, workflow `ci.yml`).
   - **Token:** create a granular Automation token with read/write on `sqlite-mem`, then add repo secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
2. Confirm GitHub Actions is enabled and can create releases (default `GITHUB_TOKEN` is enough with this workflow’s permissions).
3. Ensure the baseline tag exists and is pushed: `v0.1.0` (semver continues from there; the next `feat` publishes `0.2.0`).

After that, every green push to `main` with releasable commits updates npm automatically.

## License

MIT
