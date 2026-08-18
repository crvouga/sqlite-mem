import { SqliteError } from "../errors/index.ts";
import type { Rowid } from "../storage/row.ts";
import { compareSql, isSqlJsonText, isSqlReal, type SqlValue } from "../types/value.ts";

export class IndexStore {
  readonly name: string;
  private entries: Map<string, Rowid[]>;
  private keyValues: Map<string, SqlValue[]>;
  private sortedKeys: string[] | null;
  frozen = false;

  constructor(
    name = "index",
    entries?: ReadonlyMap<string, readonly Rowid[]>,
    keyValues?: ReadonlyMap<string, readonly SqlValue[]>,
  ) {
    this.name = name;
    this.entries = new Map();
    this.keyValues = new Map();
    this.sortedKeys = null;
    if (entries) {
      for (const [key, rowids] of entries) this.entries.set(key, [...rowids]);
    }
    if (keyValues) {
      for (const [key, values] of keyValues) this.keyValues.set(key, [...values]);
    }
  }

  checkUnique(values: readonly SqlValue[], rowid?: Rowid): void {
    const key = serializeIndexKey(values);
    if (key === null) return;
    const existing = this.entries.get(key);
    if (!existing) return;
    for (const id of existing) {
      if (rowid === undefined || !sameRowid(id, rowid)) {
        throw new SqliteError(
          `UNIQUE constraint failed: ${this.name}`,
          "constraint_unique",
          "SQLITE_CONSTRAINT_UNIQUE",
        );
      }
    }
  }

  insert(values: readonly SqlValue[], rowid: Rowid, unique = true): void {
    this.assertMutable();
    const key = serializeIndexKey(values);
    if (key === null) return;
    if (unique) this.checkUnique(values, rowid);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, [rowid]);
      this.keyValues.set(key, [...values]);
      this.sortedKeys = null;
      return;
    }
    for (const id of existing) if (sameRowid(id, rowid)) return;
    existing.push(rowid);
  }

  lookup(values: readonly SqlValue[]): readonly Rowid[] {
    const key = serializeIndexKey(values);
    if (key === null) return [];
    return this.entries.get(key) ?? [];
  }

  /** Leftmost prefix match: INDEX(a,b) used for WHERE a = ?. */
  lookupPrefix(values: readonly SqlValue[]): readonly Rowid[] {
    if (values.length === 0) return [];
    const prefix = serializeIndexKey(values);
    if (prefix === null) return [];
    const exact = this.entries.get(prefix);
    const needle = `${prefix}|`;
    const rowids: Rowid[] = exact ? [...exact] : [];
    for (const [key, ids] of this.entries) {
      if (key.startsWith(needle)) rowids.push(...ids);
    }
    return rowids;
  }

  /**
   * Ordered scan of rowids for a single-column comparison.
   * `op` applies to the first key component.
   */
  rangeLookup(op: ">" | ">=" | "<" | "<=" | "between", bound: SqlValue, bound2?: SqlValue): readonly Rowid[] {
    const rowids: Rowid[] = [];
    const keys = this.orderedKeys();
    for (const key of keys) {
      const values = this.keyValues.get(key);
      if (!values || values[0] === undefined) continue;
      const cmp = compareSerializedOrder(values[0]!, bound);
      let ok = false;
      if (op === ">") ok = cmp > 0;
      else if (op === ">=") ok = cmp >= 0;
      else if (op === "<") ok = cmp < 0;
      else if (op === "<=") ok = cmp <= 0;
      else if (op === "between" && bound2 !== undefined) {
        ok = cmp >= 0 && compareSerializedOrder(values[0]!, bound2) <= 0;
      }
      if (ok) {
        const ids = this.entries.get(key);
        if (ids) rowids.push(...ids);
      }
    }
    return rowids;
  }

  orderedRowids(desc = false): readonly Rowid[] {
    const keys = this.orderedKeys();
    const rowids: Rowid[] = [];
    const seq = desc ? [...keys].reverse() : keys;
    for (const key of seq) {
      const ids = this.entries.get(key);
      if (ids) rowids.push(...ids);
    }
    return rowids;
  }

  remove(values: readonly SqlValue[], rowid?: Rowid): boolean {
    this.assertMutable();
    const key = serializeIndexKey(values);
    if (key === null) return false;
    const existing = this.entries.get(key);
    if (!existing) return false;
    if (rowid === undefined) {
      this.entries.delete(key);
      this.keyValues.delete(key);
      this.sortedKeys = null;
      return true;
    }
    const index = existing.findIndex((id) => sameRowid(id, rowid));
    if (index < 0) return false;
    existing.splice(index, 1);
    if (existing.length === 0) {
      this.entries.delete(key);
      this.keyValues.delete(key);
      this.sortedKeys = null;
    }
    return true;
  }

  clear(): void {
    this.assertMutable();
    this.entries.clear();
    this.keyValues.clear();
    this.sortedKeys = null;
  }

  clone(): IndexStore {
    return new IndexStore(this.name, this.entries, this.keyValues);
  }

  freeze(): void {
    this.frozen = true;
  }

  get size(): number {
    return this.entries.size;
  }

  private orderedKeys(): string[] {
    if (this.sortedKeys) return this.sortedKeys;
    const keys = [...this.entries.keys()];
    keys.sort((a, b) => {
      const left = this.keyValues.get(a);
      const right = this.keyValues.get(b);
      if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
      const n = Math.min(left.length, right.length);
      for (let i = 0; i < n; i++) {
        const cmp = compareSql(left[i] ?? null, right[i] ?? null);
        if (cmp !== 0) return cmp ?? 0;
      }
      return left.length - right.length;
    });
    this.sortedKeys = keys;
    return keys;
  }

  private assertMutable(): void {
    if (this.frozen) throw new SqliteError("internal: cannot mutate a frozen index", "other");
  }
}

export function serializeIndexKey(values: readonly SqlValue[]): string | null {
  if (values.some((value) => value === null)) return null;
  return (values as readonly Exclude<SqlValue, null>[])
    .map(serializeValue)
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

function serializeValue(value: Exclude<SqlValue, null>): string {
  if (isSqlReal(value)) {
    const n = value.value;
    if (Number.isNaN(n)) return "f:nan";
    if (n === Infinity) return "f:+inf";
    if (n === -Infinity) return "f:-inf";
    return `f:${Object.is(n, -0) ? "0" : n.toString()}`;
  }
  if (isSqlJsonText(value)) return `t:${value.value}`;
  if (typeof value === "bigint") return `n:${value.toString()}`;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return `n:${BigInt(value).toString()}`;
    if (Number.isNaN(value)) return "f:nan";
    if (value === Infinity) return "f:+inf";
    if (value === -Infinity) return "f:-inf";
    return `f:${Object.is(value, -0) ? "0" : value.toString()}`;
  }
  if (typeof value === "string") return `t:${value}`;
  let hex = "";
  for (const byte of value) hex += byte.toString(16).padStart(2, "0");
  return `b:${hex}`;
}

function compareSerializedOrder(left: SqlValue, right: SqlValue): number {
  return compareSql(left, right) ?? 0;
}

function sameRowid(left: Rowid, right: Rowid): boolean {
  return typeof left === "bigint" || typeof right === "bigint" ? BigInt(left) === BigInt(right) : left === right;
}
