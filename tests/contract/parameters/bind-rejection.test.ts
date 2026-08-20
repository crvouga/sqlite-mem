import { expect, test } from "bun:test";
import { Database, SqliteError } from "../../../src/index.ts";

/**
 * Intentional API divergence: JS NaN / Infinity / undefined binds are rejected.
 * bun:sqlite coerces NaN→NULL and accepts Infinity. Pin so the divergence cannot drift.
 * @no-oracle (intentional divergence nan-infinity-bind)
 */
test("NaN bind is datatype_mismatch", () => {
  const db = new Database();
  expect(() => db.query("SELECT ?", [Number.NaN])).toThrow(SqliteError);
  try {
    db.query("SELECT ?", [Number.NaN]);
  } catch (error) {
    expect((error as SqliteError).category).toBe("datatype_mismatch");
  }
});

test("Infinity bind is datatype_mismatch", () => {
  const db = new Database();
  expect(() => db.query("SELECT ?", [Number.POSITIVE_INFINITY])).toThrow(SqliteError);
  try {
    db.query("SELECT ?", [Number.POSITIVE_INFINITY]);
  } catch (error) {
    expect((error as SqliteError).category).toBe("datatype_mismatch");
  }
});

test("undefined bind is rejected", () => {
  const db = new Database();
  expect(() => db.query("SELECT ?", [undefined as unknown as null])).toThrow(SqliteError);
});
