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

export type EngineKind = "mem" | "sqlite" | "both";

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
  setup?: (engine: BenchEngine) => unknown;
  fn: (engine: BenchEngine, ctx: unknown) => void;
  teardown?: (engine: BenchEngine, ctx: unknown) => void;
  extra?: (ctx: unknown) => Record<string, number | string> | undefined;
}

export interface BenchResult {
  name: string;
  datasetSize: number | string | null;
  operation: string;
  engine: string;
  iterations: number;
  warmup: number;
  opsPerSample: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  opsPerSec: number;
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
