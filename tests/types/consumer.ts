/**
 * Compile-only checks that the published `dist` types are complete and strict.
 * Run after `bun run build` via `bun run typecheck:package`.
 */
import {
  Database,
  DEFAULT_DATABASE_SEED,
  DEFAULT_NOW,
  parse,
  Prng,
  SqliteError,
  SqlJsonText,
  SqlReal,
  Statement,
  tokenize,
} from "../../dist/index.js";
import type {
  BindValue,
  ErrorCategory,
  ParsedStatement,
  QueryRow,
  QueryValue,
  ResultSet,
  RunResult,
  Token,
} from "../../dist/index.js";

const db = new Database({
  seed: 1,
  now: new Date("2012-06-15T12:34:56.000Z"),
  prng: new Prng(2),
});

db.exec(
  `
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO users (name) VALUES (?);
`,
  ["Ada"],
);

const rows: QueryRow[] = db.query("SELECT id, name FROM users");
const name: QueryValue | undefined = rows[0]?.name;

const typed = db.query<{ id: number; name: string }>("SELECT id, name FROM users");
const id: number = typed[0]!.id;

const stmt: Statement = db.prepare("SELECT id, name FROM users WHERE id = ?");
stmt.bind(1);
const all: QueryRow[] = stmt.all();
const one: QueryRow | undefined = stmt.get(1);
const run: RunResult = db.prepare("INSERT INTO users (name) VALUES (?)").run("Bob");
const changes: number = run.changes;
const lastId: number | bigint = run.lastInsertRowid;
const result: ResultSet = stmt.result();
const columns: string[] = result.columns;

db.transaction(() => {
  db.exec("INSERT INTO users (name) VALUES (?)", ["Eve"]);
});

const snap: Uint8Array = db.snapshot();
const restored = new Database();
restored.restore(snap);

const seed: number | bigint = db.seed;
const defaultSeed: number = DEFAULT_DATABASE_SEED;
const defaultNow: Date = DEFAULT_NOW;

try {
  db.exec("SELECT * FROM missing");
} catch (err) {
  if (err instanceof SqliteError) {
    const category: ErrorCategory = err.category;
    const message: string = err.message;
    void category;
    void message;
  }
}

const ast: ParsedStatement[] = parse("SELECT 1 AS n");
const tokens: Token[] = tokenize("SELECT 1");
const bindable: BindValue[] = [
  null,
  1,
  1n,
  "text",
  true,
  new Uint8Array([1]),
  new ArrayBuffer(2),
  new SqlReal(1),
  new SqlJsonText("{}"),
];
db.exec("SELECT ?", bindable);

db.close();

void all;
void ast;
void changes;
void columns;
void defaultNow;
void defaultSeed;
void id;
void lastId;
void name;
void one;
void result;
void seed;
void tokens;
void typed;

// @ts-expect-error Statement is only constructed via Database.prepare
new Statement();

// @ts-expect-error factory is stripped from the published types
Statement.create(db, "SELECT 1", []);

// @ts-expect-error objects are not valid bind parameters
db.exec("SELECT ?", [{ nested: true }]);

// @ts-expect-error Dates are not valid bind parameters
db.exec("SELECT ?", [new Date()]);

const closed = new Database();
closed.close();

// Internal engine state is omitted from the published .d.ts
const internalDb = new Database();
// @ts-expect-error catalog state is not part of the public type surface
internalDb.state;
// @ts-expect-error PRNG is configured via constructor options, not a public field
internalDb.prng;
// @ts-expect-error clock is configured via constructor options, not a public field
internalDb.now;
// @ts-expect-error transaction manager is not part of the public type surface
internalDb.transactions;
