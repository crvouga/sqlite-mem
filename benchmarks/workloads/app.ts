import type { BenchSpec } from "../harness/types.ts";
import { fillAppSchema, fillUsers } from "./populate.ts";
import { spec } from "./tiers.ts";

export function appSpecs(): BenchSpec[] {
  return [
    spec({
      name: "workload-a/crud-loop/100",
      operation: "local-first CRUD loop",
      datasetSize: 100,
      tiers: ["ci", "default", "full"],
      warmup: 1,
      iterations: 8,
      opsPerSample: 50,
      setup: (engine) => {
        fillUsers(engine, 100);
        return {
          ins: engine.prepare("INSERT INTO users(email, name, created_at) VALUES (?, ?, ?)"),
          get: engine.prepare("SELECT id, name FROM users WHERE id = ?"),
          upd: engine.prepare("UPDATE users SET name = ? WHERE id = ?"),
          list: engine.prepare("SELECT id, name FROM users ORDER BY id DESC LIMIT 20"),
          del: engine.prepare("DELETE FROM users WHERE email = ?"),
        };
      },
      fn: (engine, ctx) => {
        const s = ctx as {
          ins: { run: (...a: unknown[]) => { lastInsertRowid: number | bigint } };
          get: { get: (id: unknown) => unknown };
          upd: { run: (...a: unknown[]) => unknown };
          list: { all: () => unknown };
          del: { run: (...a: unknown[]) => unknown };
        };
        for (let i = 0; i < 50; i++) {
          const email = `tmp-${i}-${Math.random()}@ex.test`;
          const inserted = s.ins.run(email, `Tmp ${i}`, 1_700_000_000);
          s.get.get(inserted.lastInsertRowid);
          s.upd.run(`Renamed ${i}`, inserted.lastInsertRowid);
          s.list.all();
          s.del.run(email);
        }
        void engine;
      },
    }),
    spec({
      name: "workload-b/sync-batch/1000",
      operation: "sync batch apply",
      datasetSize: 1000,
      tiers: ["ci", "default", "full"],
      warmup: 1,
      iterations: 6,
      setup: (engine) => {
        engine.exec(`CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
        engine.exec("CREATE INDEX idx_items_updated ON items(updated_at)");
        const ins = engine.prepare("INSERT INTO items(id, version, payload, updated_at) VALUES (?, ?, ?, ?)");
        engine.transaction(() => {
          for (let i = 1; i <= 1000; i++) ins.run(i, 1, `p${i}`, 1000 + i);
        });
        return {
          upd: engine.prepare("UPDATE items SET version = version + 1, payload = ?, updated_at = ? WHERE id = ?"),
          changed: engine.prepare("SELECT id, version FROM items WHERE updated_at > ?"),
        };
      },
      fn: (engine, ctx) => {
        const s = ctx as {
          upd: { run: (...a: unknown[]) => unknown };
          changed: { all: (t: number) => unknown };
        };
        engine.transaction(() => {
          for (let i = 1; i <= 50; i++) s.upd.run(`p${i}-x`, 10_000 + i, i);
        });
        s.changed.all(10_000);
      },
    }),
    spec({
      name: "workload-c/app-queries/200",
      operation: "indexed app queries",
      datasetSize: 200,
      tiers: ["ci", "default", "full"],
      warmup: 1,
      iterations: 8,
      setup: (engine) => {
        fillAppSchema(engine, 200);
        return {
          user: engine.prepare("SELECT id, name FROM users WHERE email = ?"),
          projectTasks: engine.prepare(
            "SELECT t.id, t.title FROM tasks t WHERE t.project_id = ? AND t.completed = 0 ORDER BY t.id LIMIT 50",
          ),
          join: engine.prepare(`
            SELECT u.name, COUNT(t.id) AS open_tasks
            FROM users u
            JOIN tasks t ON t.assignee_id = u.id
            WHERE t.completed = 0
            GROUP BY u.id, u.name
            ORDER BY open_tasks DESC
            LIMIT 20
          `),
        };
      },
      fn: (_engine, ctx) => {
        const s = ctx as {
          user: { get: (email: string) => unknown };
          projectTasks: { all: (id: number) => unknown };
          join: { all: () => unknown };
        };
        s.user.get("u100@ex.test");
        s.projectTasks.all(5);
        s.join.all();
      },
    }),
    spec({
      name: "workload-c/app-queries/2000",
      operation: "indexed app queries",
      datasetSize: 2000,
      tiers: ["default", "full"],
      warmup: 1,
      iterations: 6,
      setup: (engine) => {
        fillAppSchema(engine, 2000);
        return {
          user: engine.prepare("SELECT id, name FROM users WHERE email = ?"),
          projectTasks: engine.prepare("SELECT t.id, t.title FROM tasks t WHERE t.project_id = ? LIMIT 50"),
          join: engine.prepare(`
            SELECT u.name, COUNT(t.id) AS open_tasks
            FROM users u
            JOIN tasks t ON t.assignee_id = u.id
            WHERE t.completed = 0
            GROUP BY u.id, u.name
            LIMIT 20
          `),
        };
      },
      fn: (_engine, ctx) => {
        const s = ctx as {
          user: { get: (email: string) => unknown };
          projectTasks: { all: (id: number) => unknown };
          join: { all: () => unknown };
        };
        s.user.get("u1000@ex.test");
        s.projectTasks.all(10);
        s.join.all();
      },
    }),
  ];
}
