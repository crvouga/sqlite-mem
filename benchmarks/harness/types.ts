export type SuiteTier = "ci" | "default" | "full";

export interface MemorySample {
  heapUsed?: number;
  heapTotal?: number;
  rss?: number;
}

export interface BenchStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
}

export interface BenchEngine {
  readonly name: string;
  exec(sql: string, params?: unknown[]): void;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  prepare(sql: string): BenchStatement;
  transaction<T>(fn: () => T): T;
  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
  close(): void;
}

export type EngineFactory = () => BenchEngine;

export interface NamedFactory {
  name: string;
  create: EngineFactory;
}

export type EngineKind = "mem" | "sqlite" | "alasql" | "compare" | "both";

export interface BenchSpec {
  name: string;
  operation: string;
  datasetSize?: number | string;
  /** Which suite tiers include this benchmark. */
  tiers: SuiteTier[];
  engines?: EngineKind;
  warmup: number;
  iterations: number;
  /**
   * How many logical operations `fn` performs per timed sample.
   * Used for ops/sec. Default 1.
   */
  opsPerSample?: number;
  /**
   * Measurement layer for reports: raw engine, sqlite-mem API, or app composition.
   */
  layer?: "engine" | "api" | "app";
  /**
   * When true, recreate the engine and re-run setup for every timed iteration
   * so stateful benches (inserts, etc.) do not accumulate across samples.
   */
  isolateIterations?: boolean;
  setup?: (engine: BenchEngine) => unknown;
  fn: (engine: BenchEngine, ctx: unknown) => void;
  teardown?: (engine: BenchEngine, ctx: unknown) => void;
  extra?: (ctx: unknown) => Record<string, number | string> | undefined;
}

/** Minimum timed samples before percentile columns are considered reliable. */
export const RELIABLE_PERCENTILE_MIN_SAMPLES = 5;

export interface BenchResult {
  name: string;
  datasetSize: number | string | null;
  operation: string;
  engine: string;
  iterations: number;
  warmup: number;
  opsPerSample: number;
  /** Wall-clock sample stats (one timed `fn` call). */
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  opsPerSec: number;
  /** Mean ms per logical op (`mean / opsPerSample`). */
  perOpMs: number;
  /** False when iterations are too few for meaningful p95/p99. */
  reliablePercentiles: boolean;
  /** Optional layer tag: engine | api | app */
  layer?: string;
  memoryBefore?: MemorySample;
  memoryAfter?: MemorySample;
  extra?: Record<string, number | string>;
}

export interface EnvironmentInfo {
  runtime: string;
  runtimeVersion: string;
  browser?: string;
  userAgent?: string;
  cpuThrottle?: number;
  deviceProfile?: string;
  platform: string;
}

export interface BenchReport {
  generatedAt: string;
  tier: SuiteTier;
  environment: EnvironmentInfo;
  results: BenchResult[];
}
