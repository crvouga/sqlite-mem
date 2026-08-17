import type { BenchReport, BenchResult, EnvironmentInfo } from "./types.ts";

export function detectEnvironment(overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  const proc = globalThis as {
    process?: { versions?: { bun?: string; node?: string }; platform?: string };
    navigator?: { userAgent?: string };
    Bun?: { version?: string };
  };
  const bunVersion = proc.Bun?.version ?? proc.process?.versions?.bun;
  const nodeVersion = proc.process?.versions?.node;
  const runtime = bunVersion ? "bun" : typeof document !== "undefined" ? "browser" : nodeVersion ? "node" : "unknown";
  const runtimeVersion = bunVersion ?? nodeVersion ?? proc.navigator?.userAgent ?? "unknown";
  return {
    runtime,
    runtimeVersion,
    platform: proc.process?.platform ?? (typeof navigator !== "undefined" ? "browser" : "unknown"),
    userAgent: proc.navigator?.userAgent,
    ...overrides,
  };
}

export function formatMs(value: number): string {
  if (value < 0.01) return `${(value * 1000).toFixed(2)}µs`;
  if (value < 10) return `${value.toFixed(3)}ms`;
  if (value < 1000) return `${value.toFixed(2)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

export function formatBytes(value?: number): string {
  if (value === undefined) return "n/a";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(2)}MB`;
}

export function formatReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`sqlite-mem benchmark  tier=${report.tier}  ${report.generatedAt}`);
  lines.push(
    `env: ${report.environment.runtime} ${report.environment.runtimeVersion}  platform=${report.environment.platform}`,
  );
  if (report.environment.browser) {
    lines.push(
      `browser: ${report.environment.browser}  throttle=${report.environment.cpuThrottle ?? 1}x  device=${report.environment.deviceProfile ?? "desktop"}`,
    );
  }
  lines.push("");
  const header = [
    "name".padEnd(48),
    "engine".padEnd(12),
    "n".padStart(8),
    "p50".padStart(12),
    "p95".padStart(12),
    "p99".padStart(12),
    "ops/s".padStart(14),
    "heapΔ".padStart(10),
  ].join(" ");
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const result of report.results) {
    const heapBefore = result.memoryBefore?.heapUsed;
    const heapAfter = result.memoryAfter?.heapUsed;
    const delta = heapBefore !== undefined && heapAfter !== undefined ? heapAfter - heapBefore : undefined;
    lines.push(
      [
        result.name.slice(0, 48).padEnd(48),
        result.engine.padEnd(12),
        String(result.datasetSize ?? "").padStart(8),
        formatMs(result.p50).padStart(12),
        formatMs(result.p95).padStart(12),
        formatMs(result.p99).padStart(12),
        result.opsPerSec.toFixed(0).padStart(14),
        formatBytes(delta).padStart(10),
      ].join(" "),
    );
  }
  lines.push("");
  lines.push(`${report.results.length} results`);
  return lines.join("\n");
}

export function toJson(report: BenchReport): string {
  return `${JSON.stringify(report, jsonReplacer, 2)}\n`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 1e6) / 1e6;
  }
  return value;
}

export function compareReports(
  baseline: BenchReport,
  current: BenchReport,
  slowerThan = 2,
): { name: string; engine: string; ratio: number; baselineP95: number; currentP95: number }[] {
  const regressions: {
    name: string;
    engine: string;
    ratio: number;
    baselineP95: number;
    currentP95: number;
  }[] = [];
  const currentByKey = new Map(current.results.map((result) => [`${result.engine}::${result.name}`, result]));
  for (const base of baseline.results) {
    const match = currentByKey.get(`${base.engine}::${base.name}`);
    if (!match || base.p95 <= 0) continue;
    const ratio = match.p95 / base.p95;
    if (ratio > slowerThan) {
      regressions.push({
        name: base.name,
        engine: base.engine,
        ratio,
        baselineP95: base.p95,
        currentP95: match.p95,
      });
    }
  }
  return regressions;
}

export function findResult(
  results: readonly BenchResult[],
  name: string,
  engine = "sqlite-mem",
): BenchResult | undefined {
  return results.find((result) => result.name === name && result.engine === engine);
}
