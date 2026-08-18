import { type ResultSet, SqliteError } from "@crvouga/sqlite-mem";
import { getDb } from "./db.ts";

export type SqlErrorInfo = {
  message: string;
  category?: string;
  sqliteCode?: string;
};

export type SqlOutcome = { ok: true; result: ResultSet } | { ok: false; error: SqlErrorInfo };

export const SAMPLES: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "Join + GROUP BY",
    sql: `SELECT u.name, count(p.id) AS posts
FROM users u
LEFT JOIN posts p ON p.user_id = u.id
GROUP BY u.id, u.name
ORDER BY u.id;`,
  },
  {
    label: "Insert user",
    sql: `INSERT INTO users (name) VALUES ('Carol');
SELECT * FROM users ORDER BY id;`,
  },
  {
    label: "json_object",
    sql: `SELECT json_object('id', id, 'name', name) AS user FROM users ORDER BY id;`,
  },
  {
    label: "date('now')",
    sql: `SELECT date('now') AS today, datetime('now') AS now;`,
  },
];

export const DEFAULT_SQL = SAMPLES[0]?.sql ?? "SELECT 1;";

export function runSql(sql: string): SqlOutcome {
  try {
    const result = getDb().prepare(sql).result();
    return { ok: true, result };
  } catch (err) {
    if (err instanceof SqliteError) {
      return {
        ok: false,
        error: { message: err.message, category: err.category, sqliteCode: err.sqliteCode },
      };
    }
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}
