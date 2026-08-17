import { sampleMemory } from "./memory.ts";
import { detectEnvironment, formatReport } from "./report.ts";
import { nowMs, summarize } from "./stats.ts";
import type {
  BenchEngine,
  BenchReport,
  BenchResult,
  BenchSpec,
  EngineFactory,
  EnvironmentInfo,
  NamedFactory,
  SuiteTier,
} from "./types.ts";

export type { NamedFactory };

function engineAllowed(spec: BenchSpec, engineName: string): boolean {
  const kind = spec.engines ?? "both";
  if (kind === "both") return true;
  if (kind === "mem") return engineName === "sqlite-mem";
  if (kind === "sqlite") return engineName === "bun-sqlite";
  return true;
}

export function specsForTier(specs: readonly BenchSpec[], tier: SuiteTier): BenchSpec[] {
  return specs.filter((spec) => spec.tiers.includes(tier));
}

function countsForTier(spec: BenchSpec, tier: SuiteTier): { warmup: number; iterations: number } {
  if (tier === "ci") return { warmup: Math.min(spec.warmup, 1), iterations: Math.min(spec.iterations, 6) };
  if (tier === "default") return { warmup: Math.min(spec.warmup, 3), iterations: Math.min(spec.iterations, 12) };
  return { warmup: spec.warmup, iterations: spec.iterations };
}

export function runSpec(spec: BenchSpec, factory: EngineFactory, tier: SuiteTier = "full"): BenchResult {
  const engine: BenchEngine = factory();
  const { warmup, iterations } = countsForTier(spec, tier);
  let ctx: unknown;
  try {
    ctx = spec.setup?.(engine);
    const opsPerSample = spec.opsPerSample ?? 1;
    for (let i = 0; i < warmup; i++) spec.fn(engine, ctx);
    const memoryBefore = sampleMemory();
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = nowMs();
      spec.fn(engine, ctx);
      samples.push(nowMs() - start);
    }
    const memoryAfter = sampleMemory();
    spec.teardown?.(engine, ctx);
    const stats = summarize(samples, opsPerSample);
    const extra = spec.extra?.(ctx);
    if (extra && typeof extra.snapshotBytes === "number" && stats.mean > 0) {
      extra.mbPerSec = extra.snapshotBytes / 1e6 / (stats.mean / 1000);
    }
    return {
      name: spec.name,
      datasetSize: spec.datasetSize ?? null,
      operation: spec.operation,
      engine: engine.name,
      iterations,
      warmup,
      opsPerSample,
      ...stats,
      memoryBefore,
      memoryAfter,
      extra,
    };
  } finally {
    engine.close();
  }
}

export interface RunSuiteOptions {
  factories: NamedFactory[];
  specs: readonly BenchSpec[];
  tier: SuiteTier;
  environment?: Partial<EnvironmentInfo>;
  onResult?: (result: BenchResult) => void;
}

export function runSuite(options: RunSuiteOptions): BenchReport {
  const selected = specsForTier(options.specs, options.tier);
  const results: BenchResult[] = [];
  for (const spec of selected) {
    for (const factory of options.factories) {
      if (!engineAllowed(spec, factory.name)) continue;
      try {
        const result = runSpec(spec, factory.create, options.tier);
        results.push(result);
        options.onResult?.(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`skip ${spec.name} [${factory.name}]: ${message}`);
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    tier: options.tier,
    environment: detectEnvironment(options.environment),
    results,
  };
}

export function printReport(report: BenchReport): void {
  console.log(formatReport(report));
}
