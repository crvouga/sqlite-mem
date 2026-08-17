import type { BenchSpec } from "../harness/types.ts";
import { appSpecs } from "./app.ts";
import { compareJsSpecs } from "./compare-js.ts";
import { indexSpecs, joinSpecs, parserSpecs, startupSpecs, transactionSpecs } from "./engine-ops.ts";
import { ftsSpecs, jsonSpecs } from "./json-fts.ts";
import { largeSpecs } from "./large.ts";
import { microSpecs } from "./micro.ts";
import { snapshotSpecs } from "./snapshots.ts";

export function allSpecs(): BenchSpec[] {
  return [
    ...startupSpecs(),
    ...parserSpecs(),
    ...microSpecs(),
    ...compareJsSpecs(),
    ...appSpecs(),
    ...largeSpecs(),
    ...jsonSpecs(),
    ...ftsSpecs(),
    ...transactionSpecs(),
    ...indexSpecs(),
    ...joinSpecs(),
    ...snapshotSpecs(),
  ];
}
