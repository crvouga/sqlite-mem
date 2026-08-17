import { expect } from "bun:test";
import { expectParity } from "../harness/assert.ts";
import { matrixBoth } from "../harness/matrix.ts";
import { expectStateParity } from "../harness/state-dump.ts";
import type { ContractDb, ErrorCategory, SqlValue } from "../harness/types.ts";

export function setupBoth(memory: ContractDb, sqlite: ContractDb, statements: string[]): void {
  for (const sql of statements) {
    const a = memory.exec(sql);
    const b = sqlite.exec(sql);
    expect(a.ok, `memory setup failed: ${sql}: ${a.error?.message}`).toBe(true);
    expect(b.ok, `sqlite setup failed: ${sql}: ${b.error?.message}`).toBe(true);
  }
}

export function parity(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    expectParity(memory.query(sql, params), sqlite.query(sql, params));
  });
}

export function execParity(name: string, setup: string[], sql: string, params?: SqlValue[]): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    expectParity(memory.exec(sql, params), sqlite.exec(sql, params));
  });
}

/** Statements where write counters are not meaningfully comparable across drivers. */
const COUNTER_NEUTRAL_SQL =
  /^\s*(CREATE|DROP|ALTER|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ANALYZE|REINDEX|VACUUM|ATTACH|DETACH)\b/i;

function shouldNeutralizeCounters(sql: string): boolean {
  return COUNTER_NEUTRAL_SQL.test(sql);
}

export function sequenceParity(
  name: string,
  setup: string[],
  steps: Array<{ sql: string; query?: boolean; params?: SqlValue[] }>,
  options?: { compareFinalState?: boolean },
): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    for (const step of steps) {
      const a = step.query ? memory.query(step.sql, step.params) : memory.exec(step.sql, step.params);
      const b = step.query ? sqlite.query(step.sql, step.params) : sqlite.exec(step.sql, step.params);
      if (step.query || !a.ok || !b.ok || !shouldNeutralizeCounters(step.sql)) {
        expectParity(a, b);
      } else {
        // DDL / transaction / pragma counters are not consistently defined across drivers.
        expectParity({ ...a, changes: 0, lastInsertRowid: 0 }, { ...b, changes: 0, lastInsertRowid: 0 });
      }
    }
    if (options?.compareFinalState) {
      expectStateParity(memory, sqlite);
    }
  });
}

export function errorParity(name: string, setup: string[], sql: string, category?: ErrorCategory): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    const a = memory.exec(sql);
    const b = sqlite.exec(sql);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expectParity(a, b);
    if (category) {
      expect(a.error?.category).toBe(category);
      expect(b.error?.category).toBe(category);
    }
  });
}

export function queryErrorParity(name: string, setup: string[], sql: string, category?: ErrorCategory): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    const a = memory.query(sql);
    const b = sqlite.query(sql);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expectParity(a, b);
    if (category) expect(a.error?.category).toBe(category);
  });
}
