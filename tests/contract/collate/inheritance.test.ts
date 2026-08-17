import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";

/**
 * Documented partial: column COLLATE declarations are not inherited by comparisons.
 * Use explicit COLLATE on predicates/ORDER BY, or indexed-column collations.
 */
describe("collate inheritance gap", () => {
  test("declared column COLLATE NOCASE is not applied to equality without explicit COLLATE", () => {
    const db = new Database();
    db.exec("CREATE TABLE words(value TEXT COLLATE NOCASE)");
    db.exec("INSERT INTO words VALUES ('Apple'),('banana')");
    const without = db.query<{ n: number }>("SELECT count(*) AS n FROM words WHERE value = 'apple'");
    expect(without[0]!.n).toBe(0);
    const withExplicit = db.query<{ n: number }>(
      "SELECT count(*) AS n FROM words WHERE value = 'apple' COLLATE NOCASE",
    );
    expect(withExplicit[0]!.n).toBe(1);
  });
});
