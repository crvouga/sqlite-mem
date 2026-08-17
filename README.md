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

## License

MIT
