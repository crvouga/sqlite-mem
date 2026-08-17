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
import { RELIABLE_PERCENTILE_MIN_SAMPLES } from "./types.ts";

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

function runTimedSample(spec: BenchSpec, engine: BenchEngine, ctx: unknown): number {
  const start = nowMs();
  spec.fn(engine, ctx);
  return nowMs() - start;
}

export function runSpec(spec: BenchSpec, factory: EngineFactory, tier: SuiteTier = "full"): BenchResult {
  const { warmup, iterations } = countsForTier(spec, tier);
  const opsPerSample = spec.opsPerSample ?? 1;
  const samples: number[] = [];
  let memoryBefore = sampleMemory();
  let memoryAfter = sampleMemory();
  let extraCtx: unknown;
  let engineName = "unknown";

  if (spec.isolateIterations) {
    for (let i = 0; i < warmup; i++) {
      const engine = factory();
      engineName = engine.name;
      try {
        const ctx = spec.setup?.(engine);
        spec.fn(engine, ctx);
        spec.teardown?.(engine, ctx);
      } finally {
        engine.close();
      }
    }
    memoryBefore = sampleMemory();
    for (let i = 0; i < iterations; i++) {
      const engine = factory();
      engineName = engine.name;
      try {
        const ctx = spec.setup?.(engine);
        samples.push(runTimedSample(spec, engine, ctx));
        if (i === iterations - 1) {
          extraCtx = ctx;
          memoryAfter = sampleMemory();
        }
        spec.teardown?.(engine, ctx);
      } finally {
        engine.close();
      }
    }
  } else {
    const engine = factory();
    engineName = engine.name;
    try {
      const ctx = spec.setup?.(engine);
      extraCtx = ctx;
      for (let i = 0; i < warmup; i++) spec.fn(engine, ctx);
      memoryBefore = sampleMemory();
      for (let i = 0; i < iterations; i++) {
        samples.push(runTimedSample(spec, engine, ctx));
      }
      memoryAfter = sampleMemory();
      spec.teardown?.(engine, ctx);
    } finally {
      engine.close();
    }
  }

  const stats = summarize(samples, opsPerSample);
  const extra = spec.extra?.(extraCtx);
  if (extra && typeof extra.snapshotBytes === "number" && stats.mean > 0) {
    extra.mbPerSec = extra.snapshotBytes / 1e6 / (stats.mean / 1000);
  }
  return {
    name: spec.name,
    datasetSize: spec.datasetSize ?? null,
    operation: spec.operation,
    engine: engineName,
    iterations,
    warmup,
    opsPerSample,
    ...stats,
    reliablePercentiles: iterations >= RELIABLE_PERCENTILE_MIN_SAMPLES,
    layer: spec.layer,
    memoryBefore,
    memoryAfter,
    extra,
  };
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
