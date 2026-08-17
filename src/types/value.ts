/** SQLite storage classes / SQL values used throughout the engine. */

export type StorageClass = "null" | "integer" | "real" | "text" | "blob";

export type SqlValue = null | number | bigint | string | Uint8Array;

export type Affinity = "TEXT" | "NUMERIC" | "INTEGER" | "REAL" | "BLOB";

/** Canonicalize IEEE `-0` to `+0` for cross-runtime determinism. */
export function canonicalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function storageClassOf(value: SqlValue): StorageClass {
  if (value === null) return "null";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "real";
  }
  if (typeof value === "string") return "text";
  return "blob";
}

export function typeofSql(value: SqlValue): string {
  const sc = storageClassOf(value);
  if (sc === "null") return "null";
  if (sc === "integer") return "integer";
  if (sc === "real") return "real";
  if (sc === "text") return "text";
  return "blob";
}

/** Determine column affinity from a declared type name (SQLite rules). */
export function affinityFromTypeName(typeName: string | null | undefined): Affinity {
  if (!typeName) return "BLOB";
  const t = typeName.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB")) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

export function applyAffinity(value: SqlValue, affinity: Affinity): SqlValue {
  if (value === null) return null;

  switch (affinity) {
    case "TEXT":
      if (value instanceof Uint8Array) return utf8Decode(value);
      if (typeof value === "string") return value;
      return String(value);
    case "INTEGER": {
      const n = coerceToNumber(value);
      if (n === null) return value;
      if (typeof value === "bigint") return value;
      return Number.isInteger(n) && Number.isSafeInteger(n) ? Math.trunc(n) : canonicalizeNumber(n);
    }
    case "REAL": {
      const n = coerceToNumber(value);
      return n === null ? value : canonicalizeNumber(n);
    }
    case "NUMERIC": {
      const n = coerceToNumber(value);
      if (n === null) return value;
      if (Number.isInteger(n) && Number.isSafeInteger(n)) return Math.trunc(n);
      return canonicalizeNumber(n);
    }
    case "BLOB":
      if (typeof value === "number") return canonicalizeNumber(value);
      return value;
  }
}

export function coerceToNumber(value: SqlValue): number | null {
  if (value === null) return null;
  if (typeof value === "number") return canonicalizeNumber(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isNaN(n) && /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
      return canonicalizeNumber(n);
    }
    return null;
  }
  return null;
}

export function toInteger(value: SqlValue): number | bigint | null {
  if (value === null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const n = coerceToNumber(value);
    return n === null ? null : Math.trunc(n);
  }
  return null;
}

export function sqlValueEquals(a: SqlValue, b: SqlValue): boolean {
  if (a === null || b === null) return false;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return BigInt(a as number | bigint) === BigInt(b as number | bigint);
    } catch {
      return false;
    }
  }
  return a === b;
}

/**
 * SQLite comparison for ORDER BY / inequalities.
 * Returns -1, 0, 1, or null if either side is NULL (SQL NULL).
 */
export function compareSql(a: SqlValue, b: SqlValue): number | null {
  if (a === null || b === null) return null;

  const ca = comparisonClass(a);
  const cb = comparisonClass(b);
  if (ca !== cb) return ca < cb ? -1 : 1;

  if (ca === 1) {
    // numbers — compare floats before BigInt conversion (NaN/Inf must not reach BigInt)
    if (typeof a === "number" && typeof b === "number") {
      if (Number.isNaN(a) && Number.isNaN(b)) return 0;
      if (Number.isNaN(a)) return 1;
      if (Number.isNaN(b)) return -1;
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }
    if (typeof a === "bigint" && typeof b === "bigint") {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }
    const fa = typeof a === "number" ? a : Number(a);
    const fb = typeof b === "number" ? b : Number(b);
    if (Number.isNaN(fa) && Number.isNaN(fb)) return 0;
    if (Number.isNaN(fa)) return 1;
    if (Number.isNaN(fb)) return -1;
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    return 0;
  }

  if (ca === 2) {
    const sa = String(a);
    const sb = String(b);
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  }

  // blobs
  const ba = a instanceof Uint8Array ? a : utf8Encode(String(a));
  const bb = b instanceof Uint8Array ? b : utf8Encode(String(b));
  const len = Math.min(ba.length, bb.length);
  for (let i = 0; i < len; i++) {
    const d = (ba[i] ?? 0) - (bb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (ba.length < bb.length) return -1;
  if (ba.length > bb.length) return 1;
  return 0;
}

/** SQLite sort order: NULL < numbers < text < blob */
function comparisonClass(v: SqlValue): number {
  if (v === null) return 0;
  if (typeof v === "number" || typeof v === "bigint") return 1;
  if (typeof v === "string") return 2;
  return 3;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function cloneSqlValue(v: SqlValue): SqlValue {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  return v;
}

export function isTruthySql(v: SqlValue): boolean | null {
  if (v === null) return null;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") return v.length > 0;
  return v.length > 0;
}
