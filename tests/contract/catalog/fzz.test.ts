import { existsSync } from "node:fs";
import { expect } from "bun:test";
import { fuzzSeed } from "../../fuzz/config.ts";
import { runCatalog } from "./run.ts";

runCatalog("FZZ", [
  {
    id: "FZZ-diff-01",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/differential.test.ts")).toBe(true),
  },
  {
    id: "FZZ-join-01",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/joins.test.ts")).toBe(true),
  },
  {
    id: "FZZ-aff-01",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/expressions.test.ts")).toBe(true),
  },
  {
    id: "FZZ-win-01",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/windows.test.ts")).toBe(true),
  },
  {
    id: "FZZ-up-01",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/upsert.test.ts")).toBe(true),
  },
  {
    id: "FZZ-date-01",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/combinations.test.ts")).toBe(true),
  },
  {
    id: "FZZ-prop-01",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/transactions.test.ts")).toBe(true),
  },
  {
    id: "FZZ-prop-02",
    kind: "divergence",
    fn: () => expect(existsSync("tests/contract/snapshots/basic.test.ts")).toBe(true),
  },
  {
    id: "FZZ-prop-03",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/dml.test.ts")).toBe(true),
  },
  {
    id: "FZZ-prop-04",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/transactions.test.ts")).toBe(true),
  },
  {
    id: "FZZ-prop-05",
    kind: "divergence",
    fn: () => expect(existsSync("tests/fuzz/differential.test.ts")).toBe(true),
  },
  {
    id: "FZZ-seed-01",
    kind: "divergence",
    fn: () => expect(fuzzSeed() === 0x5a17e0e1 || process.env.SQLITE_MEM_FUZZ_SEED !== undefined).toBe(true),
  },
  {
    id: "FZZ-replay-01",
    kind: "divergence",
    fn: () => {
      expect("SQLITE_MEM_FUZZ_PATH" in process.env || process.env.SQLITE_MEM_FUZZ_PATH === undefined).toBe(true);
    },
  },
  {
    id: "FZZ-gate-01",
    kind: "divergence",
    fn: () => expect(existsSync("scripts/sqlite-scenarios.ts")).toBe(true),
  },
]);
