import type { Clock } from "./clock.ts";
import type { Prng } from "./prng.ts";

/** Options for {@link Database} construction. All fields are optional. */
export interface DatabaseOptions {
  /**
   * Seed for deterministic `random()` (and any other PRNG-backed builtins).
   * Defaults to {@link DEFAULT_DATABASE_SEED} (`1`).
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

/** Default {@link DatabaseOptions.seed} when constructing a {@link Database}. */
export const DEFAULT_DATABASE_SEED = 1;
