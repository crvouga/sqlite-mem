import { expect } from "bun:test";
import { expectParity } from "../harness/assert.ts";
import { matrixBoth } from "../harness/matrix.ts";
import type { ContractDb, ErrorCategory, SqlValue } from "../harness/types.ts";

export function setupBoth(memory: ContractDb, sqlite: ContractDb, statements: string[]): void {
  for (const sql of statements) {
    const a = memory.exec(sql);
    const b = sqlite.exec(sql);
    expect(a.ok, `memory setup failed: ${sql}: ${a.error?.message}`).toBe(true);
    expect(b.ok, `sqlite setup failed: ${sql}: ${b.error?.message}`).toBe(true);
  }
}

export function parity(
  name: string,
  setup: string[],
  sql: string,
  params?: SqlValue[],
): void {
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

export function sequenceParity(
  name: string,
  setup: string[],
  steps: Array<{ sql: string; query?: boolean; params?: SqlValue[] }>,
): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    for (const step of steps) {
      const a = step.query ? memory.query(step.sql, step.params) : memory.exec(step.sql, step.params);
      const b = step.query ? sqlite.query(step.sql, step.params) : sqlite.exec(step.sql, step.params);
      if (step.query || !a.ok || !b.ok) {
        expectParity(a, b);
      } else {
        // Sequence tests assert resulting SQL behavior; write counters are adapter state,
        // and DDL/transaction statements do not reset them consistently across drivers.
        expectParity(
          { ...a, changes: 0, lastInsertRowid: 0 },
          { ...b, changes: 0, lastInsertRowid: 0 },
        );
      }
    }
  });
}

export function errorParity(
  name: string,
  setup: string[],
  sql: string,
  category?: ErrorCategory,
): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    const a = memory.exec(sql);
    const b = sqlite.exec(sql);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.error?.category).toBe(b.error?.category);
    if (category) {
      expect(a.error?.category).toBe(category);
      expect(b.error?.category).toBe(category);
    }
  });
}

export function queryErrorParity(
  name: string,
  setup: string[],
  sql: string,
  category?: ErrorCategory,
): void {
  matrixBoth(name, (memory, sqlite) => {
    setupBoth(memory, sqlite, setup);
    const a = memory.query(sql);
    const b = sqlite.query(sql);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.error?.category).toBe(b.error?.category);
    if (category) expect(a.error?.category).toBe(category);
  });
}
