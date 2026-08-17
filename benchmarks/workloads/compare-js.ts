import type { BenchEngine, BenchSpec } from "../harness/types.ts";
import { spec } from "./tiers.ts";

/**
 * Dialect-safe schema shared by sqlite-mem and AlaSQL.
 * Avoids SQLite-only INTEGER PRIMARY KEY / autoindex assumptions.
 */
function createUsers(engine: BenchEngine): void {
  engine.exec("CREATE TABLE users (id INT, email STRING, name STRING, created_at INT)");
}

function fillUsers(engine: BenchEngine, n: number): void {
  createUsers(engine);
  const ins = engine.prepare("INSERT INTO users VALUES (?,?,?,?)");
  engine.transaction(() => {
    for (let i = 1; i <= n; i++) {
      ins.run(i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
    }
  });
}

const SIZES = [
  { n: 100, tiers: ["ci", "default", "full"] as BenchSpec["tiers"] },
  { n: 1000, tiers: ["ci", "default", "full"] as BenchSpec["tiers"] },
];

/**
 * Fair core comparison suite: sqlite-mem vs AlaSQL (and any other `compare` engines).
 * Same SQL for every engine; no snapshots / FTS / SQLite-specific DDL.
 */
export function compareJsSpecs(): BenchSpec[] {
  const specs: BenchSpec[] = [];

  for (const { n, tiers } of SIZES) {
    const iterations = n >= 1000 ? 8 : 12;
    const warmup = 1;

    specs.push(
      spec({
        name: `compare/pk-lookup/${n}`,
        operation: "id equality lookup",
        datasetSize: n,
        tiers,
        engines: "compare",
        layer: "engine",
        warmup,
        iterations,
        opsPerSample: 10,
        setup: (engine) => {
          fillUsers(engine, n);
          return {
            stmt: engine.prepare("SELECT id, name FROM users WHERE id = ?"),
            id: Math.max(1, Math.floor(n / 2)),
          };
        },
        fn: (_engine, ctx) => {
          const { stmt, id } = ctx as { stmt: { get: (v: unknown) => unknown }; id: number };
          for (let i = 0; i < 10; i++) stmt.get(id);
        },
      }),
      spec({
        name: `compare/insert/${n}`,
        operation: "N inserts",
        datasetSize: n,
        tiers,
        engines: "compare",
        layer: "engine",
        isolateIterations: true,
        warmup: 0,
        iterations: n >= 1000 ? 3 : 5,
        opsPerSample: n,
        setup: (engine) => {
          createUsers(engine);
          return engine.prepare("INSERT INTO users VALUES (?,?,?,?)");
        },
        fn: (engine, ctx) => {
          const stmt = ctx as { run: (...a: unknown[]) => unknown };
          engine.transaction(() => {
            for (let i = 1; i <= n; i++) {
              stmt.run(i, `u${i}@ex.test`, `User ${i}`, 1_700_000_000 + i);
            }
          });
        },
      }),
      spec({
        name: `compare/join/${n}`,
        operation: "equality join",
        datasetSize: n,
        tiers,
        engines: "compare",
        layer: "engine",
        warmup,
        iterations,
        setup: (engine) => {
          engine.exec("CREATE TABLE small (id INT, k INT)");
          engine.exec("CREATE TABLE large (id INT, k INT, label STRING)");
          const insS = engine.prepare("INSERT INTO small VALUES (?,?)");
          const insL = engine.prepare("INSERT INTO large VALUES (?,?,?)");
          engine.transaction(() => {
            const smallN = Math.min(20, n);
            for (let i = 1; i <= smallN; i++) insS.run(i, i);
            for (let i = 1; i <= n; i++) insL.run(i, i, `L${i}`);
          });
          return engine.prepare("SELECT small.id, large.label FROM small JOIN large ON large.k = small.k");
        },
        fn: (_engine, ctx) => {
          (ctx as { all: () => unknown }).all();
        },
      }),
      spec({
        name: `compare/prepared-execute/${n}`,
        operation: "prepared id lookups",
        datasetSize: n,
        tiers,
        engines: "compare",
        layer: "engine",
        warmup,
        iterations,
        opsPerSample: n,
        setup: (engine) => {
          fillUsers(engine, Math.min(n, 1000));
          return engine.prepare("SELECT id, name FROM users WHERE id = ?");
        },
        fn: (_engine, ctx) => {
          const stmt = ctx as { get: (id: number) => unknown };
          const limit = Math.min(n, 1000);
          for (let i = 1; i <= limit; i++) stmt.get(((i - 1) % limit) + 1);
        },
      }),
    );
  }

  return specs;
}
