/** Fixed reference instant used when callers do not supply a clock. */
export const DEFAULT_NOW = new Date("2000-01-01T00:00:00.000Z");

export type Clock = () => Date;

export function fixedClock(instant: Date = DEFAULT_NOW): Clock {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError("invalid clock instant");
  return () => new Date(ms);
}

export function resolveClock(now?: Date | Clock): Clock {
  if (now === undefined) return fixedClock(DEFAULT_NOW);
  if (typeof now === "function") return () => new Date(now().getTime());
  return fixedClock(now);
}
