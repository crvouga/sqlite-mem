import type { Clock } from "./clock.ts";
import type { Prng } from "./prng.ts";

export interface DatabaseOptions {
  /**
   * Seed for deterministic `random()` (and any other PRNG-backed builtins).
   * Defaults to `1`.
   */
  seed?: number | bigint;
  /**
   * Clock for `date('now')` / `datetime('now')` / etc.
   * Defaults to a fixed instant (`2000-01-01T00:00:00.000Z`).
   * Pass a `Date` or `() => Date` to override.
   */
  now?: Date | Clock;
  /** Optional pre-built PRNG (takes precedence over `seed`). */
  prng?: Prng;
}

export const DEFAULT_DATABASE_SEED = 1;
