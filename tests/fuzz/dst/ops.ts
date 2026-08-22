import * as fc from "fast-check";
import { intArb, textArb } from "../config.ts";
import { sqlLiteral } from "../helpers.ts";

export type SchemaKind = "plain" | "without_rowid" | "strict" | "generated";

/** Shared mixed-DST op vocabulary (DML subset is also used by O3 stateful). */
export type MixedOp =
  | { kind: "insert"; a: number; b: string }
  | { kind: "update"; a: number; b: string }
  | { kind: "delete"; a: number }
  | { kind: "select" }
  | { kind: "select_subquery" }
  | { kind: "select_compound"; setOp: "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT" }
  | { kind: "upsert"; a: number; b: string; mode: "nothing" | "update" }
  | { kind: "insert_select" }
  | { kind: "update_from"; multi: boolean }
  | { kind: "insert_child"; note: string }
  | { kind: "returning_insert"; a: number; b: string }
  | { kind: "returning_update"; a: number }
  | { kind: "returning_delete"; a: number }
  | { kind: "begin" }
  | { kind: "commit" }
  | { kind: "rollback" }
  | { kind: "savepoint" }
  | { kind: "release" }
  | { kind: "rollback_to" }
  | { kind: "add_index" }
  | { kind: "drop_index" }
  | { kind: "create_partial_index" }
  | { kind: "create_expr_index" }
  | { kind: "create_unique_index" }
  | { kind: "pragma_fk" }
  | { kind: "alter_add" }
  | { kind: "create_view" }
  | { kind: "drop_view" }
  | { kind: "create_child" }
  | { kind: "create_trigger" }
  | { kind: "drop_trigger" }
  | { kind: "attach_mem" }
  | { kind: "insert_other"; a: number; b: string }
  | { kind: "checkpoint" };

export type DmlOp =
  | { kind: "insert"; a: number; b: string }
  | { kind: "update"; a: number; b: string }
  | { kind: "delete"; a: number }
  | { kind: "select" };

export interface SimState {
  nextId: number;
  nextChildId: number;
  inTxn: boolean;
  savepointDepth: number;
  hasIndex: boolean;
  hasPartialIndex: boolean;
  hasExprIndex: boolean;
  hasUniqueIndex: boolean;
  hasNote: boolean;
  hasView: boolean;
  hasChild: boolean;
  hasTrigger: boolean;
  hasAttach: boolean;
  schemaKind: SchemaKind;
  /** Applied SQL statements (for checkpoint rebuild / minimize). */
  sqlLog: string[];
  /** SELECT probes executed during the sequence (for snapshot checkpoint verification). */
  probeQueries: string[];
  /** Memory-only SQLM snapshot taken at last successful checkpoint mark. */
  snap: Uint8Array | null;
}

export function initialSimState(schemaKind: SchemaKind = "plain"): SimState {
  return {
    nextId: 1,
    nextChildId: 1,
    inTxn: false,
    savepointDepth: 0,
    hasIndex: false,
    hasPartialIndex: false,
    hasExprIndex: false,
    hasUniqueIndex: false,
    hasNote: false,
    hasView: false,
    hasChild: false,
    hasTrigger: false,
    hasAttach: false,
    schemaKind,
    sqlLog: [],
    probeQueries: [],
    snap: null,
  };
}

export function schemaFor(kind: SchemaKind): string {
  if (kind === "without_rowid") {
    return "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT) WITHOUT ROWID";
  }
  if (kind === "strict") {
    return "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT) STRICT";
  }
  if (kind === "generated") {
    return "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT, g INT GENERATED ALWAYS AS (a + 1) STORED)";
  }
  return "CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)";
}

export const OUTCOME_KINDS = new Set<MixedOp["kind"]>([
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "rollback_to",
  "add_index",
  "drop_index",
  "create_partial_index",
  "create_expr_index",
  "create_unique_index",
  "pragma_fk",
  "alter_add",
  "create_view",
  "drop_view",
  "create_child",
  "create_trigger",
  "drop_trigger",
  "attach_mem",
  "upsert",
  "insert_select",
  "update_from",
  "insert_child",
  "insert_other",
]);

export const READ_ONLY_QUERY_KINDS = new Set<MixedOp["kind"]>(["select", "select_subquery", "select_compound"]);

export const QUERY_KINDS = new Set<MixedOp["kind"]>([
  ...READ_ONLY_QUERY_KINDS,
  "returning_insert",
  "returning_update",
  "returning_delete",
]);

/** Resolve op to SQL + side-effect updates, or null to skip. */
export function resolveOp(
  op: MixedOp,
  state: SimState,
): { sql: string; isQuery: boolean; beginFirst?: boolean; extraSql?: string[] } | null {
  if (op.kind === "insert") {
    const id = state.nextId++;
    return {
      sql: `INSERT INTO t(id, a, b) VALUES (${id}, ${op.a}, ${sqlLiteral(op.b)})`,
      isQuery: false,
    };
  }
  if (op.kind === "update") {
    return {
      sql: `UPDATE t SET a = ${op.a}, b = ${sqlLiteral(op.b)} WHERE id = (SELECT max(id) FROM t)`,
      isQuery: false,
    };
  }
  if (op.kind === "delete") {
    return { sql: `DELETE FROM t WHERE a = ${op.a}`, isQuery: false };
  }
  if (op.kind === "select") {
    const cols = state.schemaKind === "generated" ? "id, a, b, g" : "id, a, b";
    return { sql: `SELECT ${cols} FROM t ORDER BY id`, isQuery: true };
  }
  if (op.kind === "select_subquery") {
    return {
      sql: "SELECT id, a, b FROM t WHERE a IN (SELECT a FROM t WHERE id > 0) OR EXISTS (SELECT 1 FROM t t2 WHERE t2.id = t.id) ORDER BY id",
      isQuery: true,
    };
  }
  if (op.kind === "select_compound") {
    return {
      sql: `SELECT a FROM t ${op.setOp} SELECT a FROM t WHERE a IS NOT NULL ORDER BY 1`,
      isQuery: true,
    };
  }
  if (op.kind === "upsert") {
    const id = state.nextId;
    const conflictId = ((id - 1) % 5) + 1;
    if (op.mode === "nothing") {
      return {
        sql: `INSERT INTO t(id, a, b) VALUES (${conflictId}, ${op.a}, ${sqlLiteral(op.b)}) ON CONFLICT(id) DO NOTHING`,
        isQuery: false,
      };
    }
    return {
      sql: `INSERT INTO t(id, a, b) VALUES (${conflictId}, ${op.a}, ${sqlLiteral(op.b)}) ON CONFLICT(id) DO UPDATE SET a = excluded.a, b = excluded.b`,
      isQuery: false,
    };
  }
  if (op.kind === "insert_select") {
    const id = state.nextId++;
    return {
      sql: `INSERT INTO t(id, a, b) SELECT ${id}, a, b FROM t WHERE id = (SELECT max(id) FROM t)`,
      isQuery: false,
    };
  }
  if (op.kind === "update_from") {
    if (!state.hasChild) return null;
    if (op.multi) {
      return {
        sql: "UPDATE t SET a = t.a + child.id FROM child WHERE t.id = child.tid",
        isQuery: false,
      };
    }
    return {
      sql: "UPDATE t SET a = t.a + 1 FROM child WHERE t.id = child.tid",
      isQuery: false,
    };
  }
  if (op.kind === "insert_child") {
    if (!state.hasChild) return null;
    const cid = state.nextChildId++;
    return {
      sql: `INSERT INTO child(id, tid, note) SELECT ${cid}, id, ${sqlLiteral(op.note)} FROM t WHERE id = (SELECT max(id) FROM t)`,
      isQuery: false,
    };
  }
  if (op.kind === "returning_insert") {
    const id = state.nextId++;
    return {
      sql: `INSERT INTO t(id, a, b) VALUES (${id}, ${op.a}, ${sqlLiteral(op.b)}) RETURNING id, a, b`,
      isQuery: true,
    };
  }
  if (op.kind === "returning_update") {
    return {
      sql: `UPDATE t SET a = ${op.a} WHERE id = (SELECT max(id) FROM t) RETURNING id, a`,
      isQuery: true,
    };
  }
  if (op.kind === "returning_delete") {
    return {
      sql: `DELETE FROM t WHERE a = ${op.a} RETURNING id, a, b`,
      isQuery: true,
    };
  }
  if (op.kind === "begin") {
    if (state.inTxn) return null;
    state.inTxn = true;
    return { sql: "BEGIN", isQuery: false };
  }
  if (op.kind === "commit") {
    if (!state.inTxn) return null;
    state.inTxn = false;
    state.savepointDepth = 0;
    return { sql: "COMMIT", isQuery: false };
  }
  if (op.kind === "rollback") {
    if (!state.inTxn) return null;
    state.inTxn = false;
    state.savepointDepth = 0;
    return { sql: "ROLLBACK", isQuery: false };
  }
  if (op.kind === "savepoint") {
    const beginFirst = !state.inTxn;
    if (beginFirst) state.inTxn = true;
    state.savepointDepth++;
    return { sql: `SAVEPOINT sp${state.savepointDepth}`, isQuery: false, beginFirst };
  }
  if (op.kind === "release") {
    if (state.savepointDepth === 0) return null;
    const sql = `RELEASE sp${state.savepointDepth}`;
    state.savepointDepth--;
    return { sql, isQuery: false };
  }
  if (op.kind === "rollback_to") {
    if (state.savepointDepth === 0) return null;
    return { sql: `ROLLBACK TO sp${state.savepointDepth}`, isQuery: false };
  }
  if (op.kind === "add_index") {
    if (state.hasIndex || state.inTxn) return null;
    state.hasIndex = true;
    return { sql: "CREATE INDEX IF NOT EXISTS t_a ON t(a)", isQuery: false };
  }
  if (op.kind === "drop_index") {
    if (!state.hasIndex || state.inTxn) return null;
    state.hasIndex = false;
    return { sql: "DROP INDEX IF EXISTS t_a", isQuery: false };
  }
  if (op.kind === "create_partial_index") {
    if (state.hasPartialIndex || state.inTxn) return null;
    state.hasPartialIndex = true;
    return { sql: "CREATE INDEX IF NOT EXISTS t_partial ON t(a) WHERE a > 0", isQuery: false };
  }
  if (op.kind === "create_expr_index") {
    if (state.hasExprIndex || state.inTxn) return null;
    state.hasExprIndex = true;
    return { sql: "CREATE INDEX IF NOT EXISTS t_expr ON t(a + 1)", isQuery: false };
  }
  if (op.kind === "create_unique_index") {
    if (state.hasUniqueIndex || state.inTxn) return null;
    state.hasUniqueIndex = true;
    return { sql: "CREATE UNIQUE INDEX IF NOT EXISTS t_a_unique ON t(a)", isQuery: false };
  }
  if (op.kind === "pragma_fk") {
    return { sql: "PRAGMA foreign_keys = ON", isQuery: false };
  }
  if (op.kind === "alter_add") {
    if (state.hasNote || state.inTxn || state.schemaKind === "without_rowid") return null;
    state.hasNote = true;
    return { sql: "ALTER TABLE t ADD COLUMN note TEXT DEFAULT ''", isQuery: false };
  }
  if (op.kind === "create_view") {
    if (state.hasView || state.inTxn) return null;
    state.hasView = true;
    return { sql: "CREATE VIEW IF NOT EXISTS t_view AS SELECT id, a FROM t", isQuery: false };
  }
  if (op.kind === "drop_view") {
    if (!state.hasView || state.inTxn) return null;
    state.hasView = false;
    return { sql: "DROP VIEW IF EXISTS t_view", isQuery: false };
  }
  if (op.kind === "create_child") {
    if (state.hasChild || state.inTxn) return null;
    state.hasChild = true;
    return {
      sql: "CREATE TABLE child(id INTEGER PRIMARY KEY, tid INT REFERENCES t(id), note TEXT)",
      isQuery: false,
    };
  }
  if (op.kind === "create_trigger") {
    if (state.hasTrigger || state.inTxn) return null;
    state.hasTrigger = true;
    return {
      sql: "CREATE TRIGGER IF NOT EXISTS t_ai AFTER INSERT ON t BEGIN INSERT INTO audit(op) VALUES ('I'); END",
      isQuery: false,
      extraSql: ["CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, op TEXT)"],
    };
  }
  if (op.kind === "drop_trigger") {
    if (!state.hasTrigger || state.inTxn) return null;
    state.hasTrigger = false;
    return { sql: "DROP TRIGGER IF EXISTS t_ai", isQuery: false };
  }
  if (op.kind === "attach_mem") {
    if (state.hasAttach || state.inTxn) return null;
    state.hasAttach = true;
    return {
      sql: "CREATE TABLE other.t(id INTEGER PRIMARY KEY, a INT, b TEXT)",
      isQuery: false,
      extraSql: ["ATTACH ':memory:' AS other"],
    };
  }
  if (op.kind === "insert_other") {
    if (!state.hasAttach) return null;
    const id = state.nextId;
    return {
      sql: `INSERT INTO other.t(id, a, b) VALUES (${id}, ${op.a}, ${sqlLiteral(op.b)})`,
      isQuery: false,
    };
  }
  if (op.kind === "checkpoint") {
    return { sql: "<checkpoint>", isQuery: false };
  }
  return null;
}

export const dmlOpArb: fc.Arbitrary<DmlOp> = fc.oneof(
  fc.record({ kind: fc.constant("insert" as const), a: intArb, b: textArb }),
  fc.record({ kind: fc.constant("update" as const), a: intArb, b: textArb }),
  fc.record({ kind: fc.constant("delete" as const), a: intArb }),
  fc.record({ kind: fc.constant("select" as const) }),
);

export const schemaKindArb: fc.Arbitrary<SchemaKind> = fc.constantFrom("plain", "without_rowid", "strict", "generated");

export const mixedOpArb: fc.Arbitrary<MixedOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("insert" as const), a: intArb, b: textArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("update" as const), a: intArb, b: textArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("delete" as const), a: intArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("select" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("select_subquery" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("select_compound" as const),
      setOp: fc.constantFrom("UNION" as const, "UNION ALL" as const, "INTERSECT" as const, "EXCEPT" as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("upsert" as const),
      a: intArb,
      b: textArb,
      mode: fc.constantFrom("nothing" as const, "update" as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("insert_select" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("update_from" as const), multi: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("insert_child" as const), note: textArb }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("returning_insert" as const), a: intArb, b: textArb }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("returning_update" as const), a: intArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("returning_delete" as const), a: intArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("begin" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("commit" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rollback" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("savepoint" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("release" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rollback_to" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("add_index" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop_index" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_partial_index" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_expr_index" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_unique_index" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("pragma_fk" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("alter_add" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_view" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_child" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create_trigger" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop_trigger" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("attach_mem" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("insert_other" as const), a: intArb, b: textArb }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop_view" as const) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("checkpoint" as const) }) },
);

export const DEFAULT_SCHEMA = schemaFor("plain");
export const SIMPLE_SCHEMA = DEFAULT_SCHEMA;
