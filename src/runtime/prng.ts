/**
 * Deterministic 64-bit PRNG (xorshift64*).
 * Used for SQLite `random()` and any other nondeterministic builtins.
 */
export class Prng {
  private state: bigint;

  constructor(seed: number | bigint = 1) {
    let s = typeof seed === "bigint" ? seed : BigInt(seed | 0);
    if (s === 0n) s = 0x9e3779b97f4a7c15n;
    this.state = BigInt.asUintN(64, s);
  }

  /** Next unsigned 64-bit value. */
  nextU64(): bigint {
    let x = this.state;
    x ^= BigInt.asUintN(64, x >> 12n);
    x ^= BigInt.asUintN(64, x << 25n);
    x ^= BigInt.asUintN(64, x >> 27n);
    this.state = BigInt.asUintN(64, x);
    return BigInt.asUintN(64, x * 0x2545f4914f6cdd1dn);
  }

  /** SQLite `random()` style signed 64-bit integer in [-2^63+1, 2^63-1]. */
  nextSqliteRandom(): bigint {
    const bits = this.nextU64();
    let signed = BigInt.asIntN(64, bits);
    if (signed === -(1n << 63n)) signed += 1n;
    return signed;
  }

  nextFloat(): number {
    const bits = this.nextU64();
    return Number(bits >> 11n) / Number(1n << 53n);
  }

  nextInt(min: number, max: number): number {
    if (max < min) throw new RangeError("max < min");
    const span = max - min + 1;
    return min + Number(this.nextU64() % BigInt(span));
  }

  /** Current unsigned 64-bit engine state (for snapshot / transaction rollback). */
  getState(): bigint {
    return this.state;
  }

  setState(state: bigint): void {
    this.state = BigInt.asUintN(64, state);
  }

  clone(): Prng {
    const copy = new Prng(1);
    copy.state = this.state;
    return copy;
  }
}

export function deriveSeed(...parts: Array<number | string | bigint>): number {
  let hash = 2166136261;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)!;
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash | 0;
}
